/**
 * The pi backend's session layer against a fake `pi --mode rpc` child
 * (`scripts/lib/pi-fake-rpc.ts`): open and the startup backlog, a recorded
 * tool turn end to end, steering and the pending queue, an interrupt that
 * clears pi's queue first, extension dialogs (answers, timeouts, withdrawal
 * before an abort), an extension command that must not block input, a
 * refused prompt, the controls read back after a change, a crash, a failed
 * startup, resume by session file path, fork and rewind wiring, project
 * trust (the question, pi's trust.json and lock, the restart, /trust), and
 * dispose. No real process.
 *
 *   node --import tsx/esm scripts/verify-pi-session.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import { openPiBackendSession } from '../src/backends/pi/backend.js'
import { piSessionDirName } from '../src/backends/pi/paths.js'
import { memoryPiPrefs } from '../src/backends/pi/prefs.js'
import type { PiExecutable } from '../src/backends/pi/rpc/binary.js'
import { writePiTrust } from '../src/backends/pi/trust.js'
import { createFakePi, fakeState, type FakePi } from './lib/pi-fake-rpc.js'
import { loadPiWire } from './lib/pi-translate-harness.js'

type Rec = Record<string, unknown>
let checks = 0
const check = (label: string, ok: unknown, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  checks += 1
  console.log(`PASS ${label}`)
}
const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const root = mkdtempSync(join(tmpdir(), 'pi-session-'))
const agentDir = join(root, 'agent')
const cwd = join(root, 'project')
mkdirSync(cwd, { recursive: true })
const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir }
delete env.PI_CODING_AGENT_SESSION_DIR
const executable: PiExecutable = { path: '/fake/bin/pi', source: 'path', command: '/fake/bin/pi', prefixArgs: [], version: '0.87.1' }
const stderrLines: string[] = []
const host = { cwd, debug: () => undefined, warn: () => undefined, locale: () => 'en' as const, stderr: (line: string) => { stderrLines.push(line) } }

/** The stdout records pi wrote for one prompt of a recorded fixture. */
function recordedRun(name: string, prompt: number): Rec[] {
  const records = loadPiWire(name).records as Rec[]
  let seen = 0
  const out: Rec[] = []
  for (const record of records) {
    const sent = record.sent as Rec | undefined
    if (sent?.type === 'prompt') { seen += 1; continue }
    if (seen !== prompt || sent !== undefined || record.type === 'response') continue
    out.push(record)
    if (record.type === 'agent_settled') break
  }
  return out
}

/** A fake with the standard startup answers. */
function standardFake(state: Rec = {}): FakePi {
  const fake = createFakePi()
  let current = fakeState(state)
  fake.on('get_state', () => current)
  fake.on('get_available_thinking_levels', () => ({ levels: ['off', 'low', 'medium', 'high'] }))
  fake.on('get_commands', () => ({ commands: [{ name: 'ask-me', source: 'extension' }, { name: 'council', description: 'Run a council', source: 'prompt' }, { name: 'skill:review', source: 'skill' }] }))
  fake.on('set_thinking_level', command => { current = { ...current, thinkingLevel: command.level }; return null })
  fake.on('set_model', command => {
    current = { ...current, model: { provider: command.provider, id: command.modelId, name: String(command.modelId), contextWindow: 64_000 } }
    return current.model
  })
  fake.on('get_available_models', () => ({ models: [
    { provider: 'faux', id: 'faux-1', name: 'Faux One', reasoning: true, thinkingLevelMap: { minimal: null, max: 'max' } },
    { provider: 'faux', id: 'faux-2', name: 'Faux Two', reasoning: false },
    { provider: 'relay', id: 'faux-2', name: 'Relayed Two', reasoning: true },
  ] }))
  return fake
}

function record(session: AgentSession) {
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  const waitFor = async <T extends AgentEvent['type']>(type: T, test: (event: Extract<AgentEvent, { type: T }>) => boolean = () => true, from = 0, timeoutMs = 3000): Promise<Extract<AgentEvent, { type: T }>> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = events.slice(from).find((event): event is Extract<AgentEvent, { type: T }> => event.type === type && test(event as Extract<AgentEvent, { type: T }>))
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}: ${JSON.stringify(events.map(event => event.type))}`)
      await tick(5)
    }
  }
  return { events, waitFor }
}

const open = (fake: FakePi, target: Parameters<typeof openPiBackendSession>[0] = { kind: 'create', cwd }): Promise<AgentSession> =>
  openPiBackendSession(target, host, { executable, spawn: fake.spawn, env, prefs: memoryPiPrefs() })

const userStart = (text: string): Rec => ({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } })

try {
  // ── Open: arguments, startup facts on subscribe ──
  {
    const fake = standardFake()
    const session = await open(fake)
    check('a new session spawns pi in RPC mode without a session path', JSON.stringify(fake.args) === JSON.stringify(['--mode', 'rpc', '--no-themes']), fake.args)
    check('the session ref is pi\'s session id', session.ref.backendId === 'pi' && session.ref.sessionId === 'fake-session')
    const log = record(session)
    const ready = await log.waitFor('session.ready')
    check('session.ready reaches a late subscriber with model, effort and window', ready.model === 'faux-1' && ready.provider === 'faux' && ready.effort === 'medium' && ready.contextWindow === 128_000 && ready.backendVersion === '0.87.1', ready)
    check('the context window is announced', log.events.some(event => event.type === 'context.capacity' && event.contextWindow === 128_000))

    // ── A recorded tool turn ──
    const run = recordedRun('tool-turn.json', 1)
    fake.on('prompt', () => { setTimeout(() => { for (const event of run) fake.emit(event) }, 1); return null })
    const accepted = await session.submit({ text: 'use tool please', clientMessageId: 'c1' }, 'turn')
    check('a prompt is accepted', accepted.accepted, accepted)
    const prompt = fake.received.find(command => command.type === 'prompt')
    check('every submission is a prompt with a streaming behavior', prompt?.message === 'use tool please' && prompt.streamingBehavior === 'followUp', prompt)
    const end = await log.waitFor('turn.end')
    check('the recorded turn completes', end.reason.kind === 'completed')
    const user = log.events.find(event => event.type === 'user.message')
    check('pi\'s user message is claimed by the client id', user?.type === 'user.message' && user.id === 'c1', user)
    const claim = log.events.findIndex(event => event.type === 'pending.changed' && (event.claimed ?? []).includes('c1'))
    check('a prompt that started at once is still claimed (the channel\'s preview retires)', claim >= 0 && claim < log.events.indexOf(user!))
    check('the session ends idle', session.status === 'idle' && log.events.some(event => event.type === 'session.status' && event.status === 'running'))

    // ── Controls: read back what pi does not announce ──
    await assert.rejects(session.capabilities.effort!.set('bogus'), /Unknown reasoning effort bogus/u)
    check('an unknown thinking level is refused before pi sees it', !fake.received.some(command => command.type === 'set_thinking_level' && command.level === 'bogus'))
    let mark = log.events.length
    await session.capabilities.effort!.set('high')
    check('a thinking level switch is read back', session.capabilities.effort!.current() === 'high' && log.events.slice(mark).some(event => event.type === 'effort.changed' && event.effort === 'high'))
    check('the catalog routes by provider (pi serves many)', session.capabilities.models!.routes === 'providers')
    const options = await session.capabilities.models!.list()
    check('model options carry their provider and the raw id', options.map(option => `${option.provider}/${option.id}`).join(',') === 'faux/faux-1,faux/faux-2,relay/faux-2' && options[2]?.label === 'Relayed Two', options)
    mark = log.events.length
    const switched = await session.capabilities.models!.set({ model: 'faux-2' })
    const setModel = fake.received.find(command => command.type === 'set_model')
    check('a bare id lands on the current provider first', switched.kind === 'switched' && setModel?.provider === 'faux' && setModel.modelId === 'faux-2', setModel)
    check('the switch is announced with its provider and the new window', log.events.slice(mark).some(event => event.type === 'model.changed' && event.model === 'faux-2' && event.provider === 'faux') && log.events.slice(mark).some(event => event.type === 'context.capacity' && event.contextWindow === 64_000))
    check('the model capability reports provider and id', JSON.stringify(session.capabilities.models!.current()) === JSON.stringify({ provider: 'faux', model: 'faux-2' }))
    await session.capabilities.models!.set({ provider: 'relay', model: 'faux-2' })
    check('a named provider is the one switched to', fake.received.filter(command => command.type === 'set_model').at(-1)?.provider === 'relay')
    await session.capabilities.models!.set({ model: 'faux-2' })
    check('a bare id now lands on the new current provider', fake.received.filter(command => command.type === 'set_model').at(-1)?.provider === 'relay')
    const preview = session.capabilities.effort!.forModel!({ provider: 'faux', model: 'faux-1' })
    check('an effort preview follows pi\'s rule for the row', preview.levels.map(level => level.id).join(',') === 'off,low,medium,high,max', preview)
    check('the preview lands the current level as pi would clamp it', preview.defaultEffort === 'high', preview)
    check('a model without reasoning previews only off', session.capabilities.effort!.forModel!({ provider: 'faux', model: 'faux-2' }).levels.map(level => level.id).join(',') === 'off')
    check('the same id under another provider previews its own row', session.capabilities.effort!.forModel!({ provider: 'relay', model: 'faux-2' }).levels.map(level => level.id).join(',') === 'off,minimal,low,medium,high')
    fake.on('get_session_stats', () => ({ contextUsage: { tokens: 1234, contextWindow: 64_000, percent: 2 } }))
    const usage = await session.capabilities.context!.usage('summary')
    check('context usage comes from get_session_stats', usage.used === 1234 && usage.max === 64_000, usage)
    await session.capabilities.rename!.rename('Renamed')
    check('rename sets pi\'s session name', fake.received.some(command => command.type === 'set_session_name' && command.name === 'Renamed'))
    const commands = await session.capabilities.commands!.list()
    check('backend commands are pi\'s extension, prompt and skill commands, then /trust', commands.map(command => command.name).join(',') === 'ask-me,council,skill:review,trust' && commands[1]?.description === 'Run a council', commands)
    const lines = session.capabilities.diagnostics!.lines()
    check('/doctor names the executable, version and session', lines.some(line => line.includes('/fake/bin/pi') && line.includes('0.87.1')) && lines.some(line => line.includes('fake-session')), lines)

    // ── Steering and the pending queue ──
    // Only the opening prompt starts a run; what follows while it runs queues.
    fake.on('prompt', command => {
      if (command.message === 'first') {
        fake.emit({ type: 'agent_start' })
        fake.emit(userStart('first'))
      }
      return null
    })
    mark = log.events.length
    await session.submit({ text: 'first', clientMessageId: 'c2' }, 'turn')
    await log.waitFor('user.message', event => event.id === 'c2', mark)
    await session.submit({ text: 'also this', clientMessageId: 'c3' }, 'steer')
    const pending = await log.waitFor('pending.changed', event => event.items.some(item => item.id === 'c3'), mark)
    check('a steer sent while running is a pending item', pending.items[0]?.placement === 'steer' && pending.items[0].text === 'also this', pending)
    check('the steer goes out as a steering prompt', fake.received.filter(command => command.type === 'prompt').at(-1)?.streamingBehavior === 'steer')
    fake.emit(userStart('also this'))
    const steered = await log.waitFor('user.message', event => event.id === 'c3', mark)
    const claimIndex = log.events.findIndex((event, index) => index >= mark && event.type === 'pending.changed' && (event.claimed ?? []).includes('c3'))
    check('the claim precedes the steered message', claimIndex >= 0 && claimIndex < log.events.indexOf(steered))
    check('the steer joins the running turn', steered.turn === (log.events.find((event, index) => index >= mark && event.type === 'user.message') as Extract<AgentEvent, { type: 'user.message' }>).turn)

    // ── Interrupt: pi's queue is cleared before the abort ──
    await session.submit({ text: 'later', clientMessageId: 'c4' }, 'followup')
    await log.waitFor('pending.changed', event => event.items.some(item => item.id === 'c4'), mark)
    fake.on('clear_queue', () => ({ steering: [], followUp: ['later'] }))
    fake.on('abort', command => { fake.emit({ type: 'agent_settled', aborted: true }); setTimeout(() => fake.respond(command), 2); return undefined })
    mark = log.events.length
    const receipt = await session.cancel('interrupt')
    check('an interrupt is confirmed with an empty queue', receipt.outcome === 'confirmed' && receipt.stillQueued.length === 0, receipt)
    const order = fake.received.map(command => command.type).filter(type => type === 'clear_queue' || type === 'abort')
    check('clear_queue goes before abort', order.join(',') === 'clear_queue,abort', order)
    check('the dropped follow-up is discarded from the dock', log.events.slice(mark).some(event => event.type === 'pending.changed' && (event.discarded ?? []).includes('c4')))
    const interrupted = await log.waitFor('turn.end', () => true, mark)
    check('the turn ends as the user\'s interrupt', interrupted.reason.kind === 'interrupted', interrupted.reason)

    // ── Extension dialogs ──
    mark = log.events.length
    fake.emit({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Pick', options: ['apple', 'pear'], timeout: 60 })
    const timed = await log.waitFor('question.request', () => true, mark)
    check('an open dialog reads as requires-action', session.status === 'requires-action')
    await log.waitFor('question.settled', event => event.requestId === timed.request.requestId, mark)
    check('a dialog pi timed out is withdrawn here, with a notice', log.events.slice(mark).some(event => event.type === 'notice' && event.text.includes('timed out')) && session.status === 'idle')
    check('a timed-out dialog is not answered late', !fake.received.some(command => command.type === 'extension_ui_response' && command.id === 'd1'))
    fake.emit({ type: 'extension_ui_request', id: 'd2', method: 'select', title: 'Pick', options: ['apple', 'pear'] })
    const select = await log.waitFor('question.request', event => event.request.requestId.endsWith('d2'), mark)
    session.capabilities.questions!.respond(select.request.requestId, { answers: [{ selected: ['pear'] }] })
    fake.emit({ type: 'extension_ui_request', id: 'd3', method: 'confirm', title: 'Sure?', message: 'really' })
    const confirm = await log.waitFor('question.request', event => event.request.requestId.endsWith('d3'), mark)
    check('a confirm dialog carries its message', confirm.request.questions[0]?.detail === 'really')
    session.capabilities.questions!.respond(confirm.request.requestId, { answers: [{ selected: ['No'] }] })
    fake.emit({ type: 'extension_ui_request', id: 'd4', method: 'editor', title: 'Edit', prefill: 'draft' })
    const editor = await log.waitFor('question.request', event => event.request.requestId.endsWith('d4'), mark)
    session.capabilities.questions!.respond(editor.request.requestId, { answers: [{ selected: [], custom: '' }] })
    fake.emit({ type: 'extension_ui_request', id: 'd5', method: 'input', title: 'Name?' })
    const input = await log.waitFor('question.request', event => event.request.requestId.endsWith('d5'), mark)
    session.capabilities.questions!.cancel(input.request.requestId)
    fake.emit({ type: 'extension_ui_request', id: 'd6', method: 'notify', message: 'heads up', notifyType: 'warning' })
    await log.waitFor('notice', event => event.text === 'heads up' && event.level === 'warning', mark)
    await tick(10)
    const answers = Object.fromEntries(fake.received.filter(command => command.type === 'extension_ui_response').map(command => [command.id, command]))
    check('select answers with the chosen option', answers.d2?.value === 'pear', answers.d2)
    check('confirm answers confirmed=false for No', answers.d3?.confirmed === false, answers.d3)
    check('an empty editor answer keeps the prefill', answers.d4?.value === 'draft', answers.d4)
    check('a dismissed dialog answers cancelled', answers.d5?.cancelled === true, answers.d5)
    check('notify needs no answer', answers.d6 === undefined)

    // ── An abort withdraws open dialogs first ──
    fake.on('prompt', () => { fake.emit({ type: 'agent_start' }); return null })
    fake.on('abort', command => { fake.emit({ type: 'agent_settled', aborted: true }); fake.respond(command); return undefined })
    await session.submit({ text: 'busy', clientMessageId: 'c5' }, 'turn')
    await tick(5)
    fake.emit({ type: 'extension_ui_request', id: 'd7', method: 'confirm', title: 'Allow?', message: 'tool' })
    await log.waitFor('question.request', event => event.request.requestId.endsWith('d7'))
    const before = fake.received.length
    await session.cancel('user')
    const after = fake.received.slice(before).map(command => command.type === 'extension_ui_response' ? `ui:${String(command.cancelled)}` : String(command.type))
    check('the open dialog is answered cancelled before the abort', after.join(',') === 'ui:true,abort', after)

    // ── An extension command does not hold the input pipeline ──
    fake.on('prompt', () => undefined) // pi answers only after the command's dialogs
    const started = Date.now()
    mark = log.events.length
    const command = await session.submit({ text: '/ask-me now', clientMessageId: 'c6' }, 'turn')
    check('an extension command is accepted at once', command.accepted && Date.now() - started < 500)
    check('an extension command is claimed at once (no message will follow)', log.events.slice(mark).some(event => event.type === 'pending.changed' && (event.claimed ?? []).includes('c6')))
    fake.on('prompt', command => { fake.emit(userStart(String(command.message))); return null })
    mark = log.events.length
    await session.submit({ text: 'next', clientMessageId: 'c7' }, 'turn')
    const next = await log.waitFor('user.message', () => true, mark)
    check('the next message keeps its own id (the command awaited none)', next.id === 'c7', next)
    fake.emit({ type: 'agent_settled' })

    // ── A refused prompt ──
    fake.on('prompt', () => { throw new Error('No model selected') })
    const refused = await session.submit({ text: 'nope', clientMessageId: 'c8' }, 'turn')
    check('a refused prompt is not accepted and says why', !refused.accepted && (refused.reason ?? '').includes('No model selected'), refused)

    // ── Framing: a torn record and stray stdout ──
    mark = log.events.length
    fake.write('not json at all\n{"type":"session_info_')
    fake.write('changed","name":"Torn Name"}\n')
    const title = await log.waitFor('session.title', () => true, mark)
    check('a record torn across writes parses, U+2028 included; junk is skipped', title.title === 'Torn Name', title)

    // ── Fork before the first save ──
    await assert.rejects(session.capabilities.fork!.fork(), /not saved yet/u)
    check('a session pi has not saved cannot be forked', true)

    // ── Dispose ──
    await session.dispose()
    check('dispose closes the child', fake.exited && session.status === 'disposed')
  }

  // ── A crash mid-turn ──
  {
    const fake = standardFake()
    const session = await open(fake)
    const log = record(session)
    fake.on('prompt', command => { fake.emit({ type: 'agent_start' }); fake.emit(userStart(String(command.message))); return null })
    await session.submit({ text: 'work', clientMessageId: 'k1' }, 'turn')
    await log.waitFor('user.message')
    fake.on('prompt', () => null)
    await session.submit({ text: 'queued behind', clientMessageId: 'k0' }, 'followup')
    fake.stderr('fatal: provider exploded')
    fake.exit(1)
    const notice = await log.waitFor('notice', event => event.key === 'pi-exit')
    check('a crash is reported with the child\'s stderr', notice.level === 'error' && notice.text.includes('provider exploded'), notice)
    const end = await log.waitFor('turn.end')
    check('the open turn closes as an error', end.reason.kind === 'error', end.reason)
    check('inputs pi never recorded are discarded', log.events.some(event => event.type === 'pending.changed' && (event.discarded ?? []).includes('k0')))
    check('the crashed session is idle and refuses input', session.status === 'idle')
    await assert.rejects(session.submit({ text: 'again', clientMessageId: 'k2' }, 'turn'), /cannot take messages/u)
    check('stderr reached the host', stderrLines.some(line => line.includes('provider exploded')))
    await session.dispose()
  }

  // ── A failed startup ──
  {
    const fake = createFakePi()
    fake.on('get_state', () => undefined)
    const opening = open(fake)
    await tick(5)
    fake.stderr('No models available. Use /login or set an API key.')
    fake.exit(1)
    await assert.rejects(opening, /pi failed to start: .*No models available/su)
    check('a startup failure names pi\'s own reason', true)
  }

  // ── Resume by session file path ──
  {
    const sessions = join(agentDir, 'sessions', piSessionDirName(cwd))
    mkdirSync(sessions, { recursive: true })
    const id = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'
    const file = join(sessions, `2026-10-01T10-00-00-000Z_${id}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd })}\n`)
    const fixture = loadPiWire('tool-turn.json')
    const fake = standardFake({ sessionId: id, sessionFile: file })
    fake.on('get_entries', () => fixture.entries)
    const session = await open(fake, { kind: 'resume', sessionId: id })
    check('a resume opens the session file by path', JSON.stringify(fake.args) === JSON.stringify(['--mode', 'rpc', '--no-themes', '--session', file]), fake.args)
    const history = await session.history()
    const users = history.filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message')
    check('the replay seed comes from get_entries, ids are entry ids', users.length === 2 && users.every(event => event.id === event.anchor && event.id.length >= 8), users.map(event => event.id))
    check('the history is handed over once', (await session.history()).length === 0)
    const files = (): string[] => readdirSync(sessions).filter(name => name.endsWith('.jsonl'))
    const before = files().length
    const forked = await session.capabilities.fork!.fork(undefined, 'Copy')
    check('a fork writes a new session file next to the source', files().length === before + 1 && files().some(name => name.includes(forked.sessionId)))
    const rewound = await session.capabilities.rewind!.rewind(users[1]!.anchor, 'conversation')
    check('a rewind from a replayed row writes the cut session', rewound.kind === 'rewound' && files().some(name => name.includes(rewound.session.sessionId)))
    check('a file rewind is refused', (await session.capabilities.rewind!.rewind(users[1]!.anchor, 'both')).kind === 'refused')
    check('an unknown anchor is refused', (await session.capabilities.rewind!.rewind('nope', 'conversation')).kind === 'refused')
    check('fork and rewind only read pi (get_entries), never change its session', !fake.received.some(command => ['fork', 'clone', 'switch_session', 'new_session'].includes(String(command.type))))
    await session.dispose()
    await assert.rejects(open(standardFake(), { kind: 'resume', sessionId: 'missing-id' }), /No pi session missing-id was found/u)
    check('an unknown session id fails loudly, nothing spawned', true)
    const gone = '0190aaaa-bbbb-7ccc-8ddd-ffffffffffff'
    writeFileSync(join(sessions, `2026-10-01T11-00-00-000Z_${gone}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id: gone, timestamp: '2026-10-01T11:00:00.000Z', cwd: join(root, 'deleted-project') })}\n`)
    await assert.rejects(open(standardFake(), { kind: 'resume', sessionId: gone }), /no longer exists/u)
    check('a session whose directory is gone fails before pi starts', true)
  }
  // ── Project trust: the question, pi's store, the restart ──
  {
    /** A project with a pi resource that needs trust. */
    const project = (name: string): string => {
      const dir = join(root, name)
      mkdirSync(join(dir, '.pi', 'prompts'), { recursive: true })
      writeFileSync(join(dir, '.pi', 'prompts', 'hello.md'), 'Say hello')
      return realpathSync(dir)
    }
    mkdirSync(agentDir, { recursive: true })
    const trustFile = join(agentDir, 'trust.json')
    const readTrust = (): string => existsSync(trustFile) ? readFileSync(trustFile, 'utf8') : ''
    const trustQuestion = (log: ReturnType<typeof record>, from = 0) =>
      log.waitFor('question.request', event => event.request.requestId.startsWith('pi-trust:'), from)
    const answer = (session: AgentSession, requestId: string, label: string): void => {
      session.capabilities.questions!.respond(requestId, { answers: [{ selected: [label] }] })
    }
    const asked = (log: ReturnType<typeof record>): boolean => log.events.some(event => event.type === 'question.request' && event.request.requestId.startsWith('pi-trust:'))
    const trustNotice = (log: ReturnType<typeof record>, text: RegExp, from = 0) =>
      log.waitFor('notice', event => event.key === 'pi-trust' && text.test(event.text), from)

    // Opening asks, with pi's choices; "Trust" is remembered as pi writes it.
    const remembered = project('remembered')
    writeFileSync(trustFile, JSON.stringify({ '/zz/other': false, '/aa/other': true }))
    const savedFile = join(root, 'remembered-session.jsonl')
    writeFileSync(savedFile, '')
    {
      const fake = standardFake({ sessionFile: savedFile })
      const session = await open(fake, { kind: 'create', cwd: remembered })
      const log = record(session)
      const question = await trustQuestion(log)
      const item = question.request.questions[0]!
      check('a project pi has no decision for is asked about on open', item.header === 'Project trust' && item.hideCustomInput === true && (item.detail ?? '').includes(remembered) && (item.detail ?? '').includes(join('.pi', 'prompts')), item)
      check('the choices are pi\'s own, in pi\'s order', item.options.map(option => option.label).join(' | ') === `Trust | Trust parent folder (${realpathSync(root)}) | Trust (this session only) | Do not trust | Do not trust (this session only)`, item.options)
      check('the old notice is gone', !log.events.some(event => event.type === 'notice' && event.key === 'pi-trust'))
      answer(session, question.request.requestId, 'Trust')
      await trustNotice(log, /pi restarted with the project's resources/u)
      const sorted = Object.fromEntries(Object.entries({ '/zz/other': false, '/aa/other': true, [remembered]: true }).sort(([a], [b]) => (a < b ? -1 : 1)))
      check('"Trust" is written to pi\'s trust.json as pi writes it (sorted, two spaces)', readTrust() === `${JSON.stringify(sorted, null, 2)}\n`, readTrust())
      check('the lock is released', !existsSync(`${trustFile}.lock`))
      check('the child restarts on the saved session file, no trust flag (pi reads the store)', fake.spawns.length === 2 && JSON.stringify(fake.spawns[1]) === JSON.stringify(['--mode', 'rpc', '--no-themes', '--session', savedFile]), fake.spawns)
      check('the question settles', log.events.some(event => event.type === 'question.settled' && event.requestId === question.request.requestId))
      check('the new child\'s commands are announced', log.events.some(event => event.type === 'commands.changed' && event.commands.some(command => command.name === 'council')))
      const restarting = log.events.findIndex(event => event.type === 'notice' && event.key === 'pi-trust' && /Restarting pi/u.test(event.text))
      check('a restart says so first (one keyed toast)', restarting >= 0 && log.events.every(event => event.type !== 'notice' || event.key !== 'pi-trust' || event.level === 'notice'))
      fake.on('get_session_stats', () => ({ contextUsage: { tokens: 7, contextWindow: 1000 } }))
      check('commands after the restart reach the new child', (await session.capabilities.context!.usage('summary')).used === 7)
      await session.dispose()
    }
    {
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: remembered })
      const log = record(session)
      await log.waitFor('session.ready')
      await tick(5)
      check('a remembered project is not asked about again', !asked(log) && fake.spawns.length === 1)
      await session.dispose()
    }

    // "Trust (this session only)": nothing written, the restart approves,
    // and later sessions of this process approve without asking.
    const once = project('once')
    {
      const before = readTrust()
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: once })
      const log = record(session)
      answer(session, (await trustQuestion(log)).request.requestId, 'Trust (this session only)')
      await trustNotice(log, /pi restarted with the project's resources/u)
      check('a session-only trust writes nothing', readTrust() === before)
      check('an unsaved session restarts under its id, approved', JSON.stringify(fake.spawns[1]) === JSON.stringify(['--mode', 'rpc', '--no-themes', '--session-id', 'fake-session', '--approve']), fake.spawns)
      await session.dispose()
      const again = standardFake()
      const next = await open(again, { kind: 'create', cwd: once })
      const nextLog = record(next)
      await nextLog.waitFor('session.ready')
      await tick(5)
      check('the next session in this process starts approved, unasked', !asked(nextLog) && again.args.includes('--approve'), again.args)
      await next.dispose()
    }

    // "Do not trust" is remembered; the untrusted child stays.
    const refused = project('refused')
    {
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: refused })
      const log = record(session)
      answer(session, (await trustQuestion(log)).request.requestId, 'Do not trust')
      await trustNotice(log, /not trusted.*\/trust/u)
      check('"Do not trust" is written as false', JSON.parse(readTrust())[refused] === false)
      check('nothing restarts for a refusal', fake.spawns.length === 1)
      await session.dispose()
    }

    // Dismissing the opening question declines for this process, as in pi.
    const dismissed = project('dismissed')
    {
      const before = readTrust()
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: dismissed })
      const log = record(session)
      session.capabilities.questions!.cancel((await trustQuestion(log)).request.requestId)
      await trustNotice(log, /not trusted.*\/trust/u)
      check('a dismissal writes nothing and restarts nothing', readTrust() === before && fake.spawns.length === 1)
      await session.dispose()
      const again = standardFake()
      const next = await open(again, { kind: 'create', cwd: dismissed })
      const nextLog = record(next)
      await nextLog.waitFor('session.ready')
      await tick(5)
      check('the next session in this process starts declined, unasked', !asked(nextLog) && again.args.includes('--no-approve'), again.args)
      await next.dispose()
    }

    // A choice made during a turn applies once the turn ends; /trust
    // reopens the question and can take trust back.
    const busy = project('busy')
    {
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: busy })
      const log = record(session)
      const question = await trustQuestion(log)
      fake.emit({ type: 'agent_start' })
      await tick(5)
      answer(session, question.request.requestId, 'Trust')
      await trustNotice(log, /once this turn ends/u)
      check('no restart while a turn runs', fake.spawns.length === 1)
      fake.emit({ type: 'agent_settled' })
      await trustNotice(log, /pi restarted with the project's resources/u)
      check('the restart follows the turn', fake.spawns.length === 2)

      const commands = await session.capabilities.commands!.list()
      check('/trust joins pi\'s commands', commands.at(-1)?.name === 'trust' && (commands.at(-1)?.description ?? '') !== '', commands)
      let mark = log.events.length
      const prompts = fake.received.filter(command => command.type === 'prompt').length
      const accepted = await session.submit({ text: '/trust', clientMessageId: 't1' }, 'turn')
      check('/trust is accepted and claimed at once, nothing goes to pi', accepted.accepted && log.events.slice(mark).some(event => event.type === 'pending.changed' && (event.claimed ?? []).includes('t1')) && fake.received.filter(command => command.type === 'prompt').length === prompts)
      const reopened = await trustQuestion(log, mark)
      check('/trust says what the child loaded', (reopened.request.questions[0]!.detail ?? '').includes('Now: trusted'), reopened.request.questions[0])
      mark = log.events.length
      session.capabilities.questions!.cancel(reopened.request.requestId)
      await tick(10)
      check('dismissing /trust changes nothing', fake.spawns.length === 2 && !log.events.slice(mark).some(event => event.type === 'notice' && event.key === 'pi-trust'))
      await session.submit({ text: '/trust', clientMessageId: 't2' }, 'turn')
      const revoke = await trustQuestion(log, mark)
      answer(session, revoke.request.requestId, 'Do not trust (this session only)')
      await trustNotice(log, /pi restarted without the project's resources/u, mark)
      check('a session-only refusal restarts the child declined', JSON.stringify(fake.spawns[2]) === JSON.stringify(['--mode', 'rpc', '--no-themes', '--session-id', 'fake-session', '--no-approve']), fake.spawns)
      check('the remembered trust stays in trust.json', JSON.parse(readTrust())[busy] === true)
      await session.dispose()
    }

    // A later answer during the turn can undo the restart it waited for.
    const undone = project('undone')
    {
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: undone })
      const log = record(session)
      const question = await trustQuestion(log)
      fake.emit({ type: 'agent_start' })
      await tick(5)
      answer(session, question.request.requestId, 'Trust (this session only)')
      await trustNotice(log, /once this turn ends/u)
      const mark = log.events.length
      await session.submit({ text: '/trust', clientMessageId: 'u1' }, 'steer')
      answer(session, (await trustQuestion(log, mark)).request.requestId, 'Do not trust (this session only)')
      await trustNotice(log, /not trusted/u, mark)
      fake.emit({ type: 'agent_settled' })
      await tick(30)
      check('an answer undone before the turn ends restarts nothing', fake.spawns.length === 1 && !log.events.some(event => event.type === 'notice' && /Restarting pi/u.test(event.text)), fake.spawns)
      await session.dispose()
    }

    // A restart that fails loses the session, as a crash does.
    const broken = project('broken')
    {
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: broken })
      const log = record(session)
      const question = await trustQuestion(log)
      fake.on('get_state', () => fakeState({ sessionId: 'someone-else' }))
      answer(session, question.request.requestId, 'Trust (this session only)')
      const failed = await log.waitFor('notice', event => event.key === 'pi-exit')
      check('a restart onto another session fails loudly', /pi failed to restart: .*someone-else/u.test(failed.text), failed.text)
      await assert.rejects(session.submit({ text: 'hi', clientMessageId: 'b1' }, 'turn'), /cannot take messages/u)
      check('the session takes no more input', true)
      await session.dispose()
    }

    // pi's lock: a fresh one is waited for, a stale one is taken over.
    {
      const lock = `${trustFile}.lock`
      mkdirSync(lock)
      const writing = writePiTrust([{ path: '/locked/project', decision: true }], env)
      await tick(120)
      check('a write waits while pi holds the lock', JSON.parse(readTrust())['/locked/project'] === undefined)
      rmSync(lock, { recursive: true })
      await writing
      check('the write lands once the lock is released', JSON.parse(readTrust())['/locked/project'] === true)
      mkdirSync(lock)
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      await writePiTrust([{ path: '/locked/project', decision: null }], env)
      check('a stale lock is taken over; null removes the key', JSON.parse(readTrust())['/locked/project'] === undefined && !existsSync(lock))
      const kept = readTrust()
      writeFileSync(trustFile, JSON.stringify({ '/kept': null, '/b': true }))
      await writePiTrust([{ path: '/a', decision: false }], env)
      check('pi\'s null entries stay, as pi keeps them', readTrust() === `${JSON.stringify({ '/a': false, '/b': true, '/kept': null }, null, 2)}\n`, readTrust())
      writeFileSync(trustFile, '{ not json')
      await assert.rejects(writePiTrust([{ path: '/a', decision: true }], env))
      check('a store pi could not read is never overwritten', readTrust() === '{ not json' && !existsSync(lock))
      const unreadable = project('unreadable')
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: unreadable })
      const log = record(session)
      answer(session, (await trustQuestion(log)).request.requestId, 'Trust')
      const failed = await log.waitFor('notice', event => event.key === 'pi-trust' && event.level === 'error')
      check('a failed write says so and restarts nothing', /Could not write pi's trust.json/u.test(failed.text) && fake.spawns.length === 1 && readTrust() === '{ not json', failed.text)
      await session.dispose()
      writeFileSync(trustFile, kept)
    }

    // Nothing to ask: a decision, a default, or no resources.
    const quiet = async (dir: string): Promise<boolean> => {
      const fake = standardFake()
      const session = await open(fake, { kind: 'create', cwd: dir })
      const log = record(session)
      await log.waitFor('session.ready')
      await tick(5)
      const seen = asked(log)
      await session.dispose()
      return !seen
    }
    const defaulted = project('defaulted')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }))
    check('a default of never asks nothing', await quiet(defaulted))
    rmSync(join(agentDir, 'settings.json'))
    check('a project without pi resources asks nothing', await quiet(cwd))
    {
      const session = await open(standardFake())
      const log = record(session)
      await session.submit({ text: '/trust', clientMessageId: 'q1' }, 'turn')
      await trustNotice(log, /no pi resources that need trust/u)
      check('/trust without resources says so instead of asking', !asked(log))
      await session.dispose()
    }
  }
  console.log(`verify-pi-session OK (${checks} checks)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
