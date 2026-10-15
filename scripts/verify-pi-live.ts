/**
 * The pi backend against a real `pi` (≥ MIN_PI_VERSION) running the scripted
 * faux model in an isolated agent directory (`scripts/lib/pi-faux.ts`): no
 * network, no provider charge, the user's `~/.pi` untouched. Covers a tool
 * turn (call, live output, result cards), extension dialogs on the
 * questionnaire, thinking-level control, an interrupt, a steer joining the
 * running turn, `/fork` and the double-Esc rewind (the files they write are
 * opened by real pi), the offline catalog (rename, delete), and a resume
 * replaying the session.
 *
 * Needs `pi` on PATH (or DSH_TUI_PI_EXECUTABLE); without a supported one it
 * prints SKIP and exits 0. Not in CI (CI has no pi).
 *
 *   node --import tsx/esm scripts/verify-pi-live.ts
 */
import assert from 'node:assert/strict'
import { piFauxHome } from './lib/pi-faux.js'

const home = piFauxHome()
process.env.PI_CODING_AGENT_DIR = home.agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_SKIP_VERSION_CHECK = '1'
delete process.env.PI_CODING_AGENT_SESSION_DIR

const { piBackend, openPiBackendSession } = await import('../src/backends/pi/backend.js')
const { resolvePiExecutable } = await import('../src/backends/pi/rpc/binary.js')
const { piVersionSupported } = await import('../src/backends/pi/contract.js')
type AgentEvent = import('../src/agent/events.js').AgentEvent
type AgentSession = import('../src/agent/session.js').AgentSession

let checks = 0
const check = (label: string, ok: unknown, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  checks += 1
  console.log(`PASS ${label}`)
}

const executable = await resolvePiExecutable(home.env)
if (executable === undefined || !piVersionSupported(executable.version)) {
  console.log(`SKIP verify-pi-live: no supported pi on PATH (${executable?.version ?? 'none'})`)
  home.cleanup()
  process.exit(0)
}

const stderr: string[] = []
const host = { cwd: home.cwd, debug: () => undefined, warn: () => undefined, locale: () => 'en' as const, stderr: (line: string) => { stderr.push(line) } }

/** A session's events, with waiting helpers. */
function recorder(session: AgentSession) {
  const events: AgentEvent[] = []
  const waiters: { readonly test: (event: AgentEvent) => boolean; readonly resolve: (event: AgentEvent) => void }[] = []
  session.subscribe(batch => {
    for (const event of batch) {
      events.push(event)
      for (const waiter of [...waiters]) {
        if (!waiter.test(event)) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(event)
      }
    }
  })
  const waitFor = <T extends AgentEvent['type']>(type: T, test: (event: Extract<AgentEvent, { type: T }>) => boolean = () => true, timeoutMs = 20_000, from = events.length): Promise<Extract<AgentEvent, { type: T }>> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type} (stderr: ${stderr.slice(-5).join(' | ')})`)), timeoutMs)
      const match = (event: AgentEvent): event is Extract<AgentEvent, { type: T }> => event.type === type && test(event as Extract<AgentEvent, { type: T }>)
      const done = (event: AgentEvent): void => { clearTimeout(timer); resolve(event as Extract<AgentEvent, { type: T }>) }
      const seen = events.slice(from).find(match)
      if (seen !== undefined) { done(seen); return }
      waiters.push({ test: match, resolve: done })
    })
  }
  return { events, waitFor, since: (index: number) => events.slice(index) }
}

let session: AgentSession | undefined
let resumed: AgentSession | undefined
try {
  session = await openPiBackendSession({ kind: 'create', cwd: home.cwd }, host)
  const sessionId = session.ref.sessionId
  check('a real pi session opens on the faux model', session.ref.backendId === 'pi' && sessionId !== '')
  const log = recorder(session)
  const ready = await log.waitFor('session.ready')
  check('session.ready names the faux model and the pi version', ready.model === 'faux/faux-1' && ready.provider === 'faux' && ready.backendVersion === executable.version, ready)
  check('the session starts idle', session.status === 'idle')

  // ── A tool turn ──
  let mark = log.events.length
  const accepted = await session.submit({ text: 'use tool please', clientMessageId: 'c-tool' }, 'turn')
  check('a prompt is accepted', accepted.accepted, accepted)
  await log.waitFor('turn.end')
  let turn = log.since(mark)
  const user = turn.find(event => event.type === 'user.message')
  check('the recorded user message carries the client id', user?.type === 'user.message' && user.id === 'c-tool' && user.text === 'use tool please', user)
  const start = turn.find(event => event.type === 'turn.start')
  check('the turn opens for that message', start?.type === 'turn.start' && start.origin === 'user' && start.userMessageId === 'c-tool', start)
  const call = turn.find(event => event.type === 'tool.call')
  check('the bash call is a terminal card', call?.type === 'tool.call' && call.name === 'bash' && call.presentation !== undefined && 'card' in call.presentation && call.presentation.card === 'terminal', call)
  const output = turn.filter(event => event.type === 'tool.output').map(event => event.type === 'tool.output' ? event.text : '').join('')
  check('the running tool streams its output', output.includes('hello-from-tool'), output)
  const result = turn.find(event => event.type === 'tool.result')
  check('the result is a terminal card with exit code 0', result?.type === 'tool.result' && !result.isError && result.presentation?.card === 'terminal' && result.presentation.exitCode === 0 && (result.presentation.output ?? '').includes('hello-from-tool'), result)
  const replies = turn.filter((event): event is Extract<AgentEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
  check('the thinking of the tool step is a reasoning block', replies[0]?.blocks.some(block => block.type === 'reasoning' && block.text === 'I should run a command.'), replies[0])
  check('the reply after the tool quotes its result', replies[1]?.blocks.some(block => block.type === 'text' && (block.text ?? '').includes('tool said: hello-from-tool')), replies[1])
  check('two steps, one turn', turn.filter(event => event.type === 'step.start').length === 2 && turn.filter(event => event.type === 'turn.start').length === 1 && turn.filter(event => event.type === 'turn.end').length === 1)
  const end = turn.find(event => event.type === 'turn.end')
  check('the turn completes', end?.type === 'turn.end' && end.reason.kind === 'completed', end)
  check('status went running then idle', turn.some(event => event.type === 'session.status' && event.status === 'running') && session.status === 'idle')

  // ── Extension dialogs ──
  mark = log.events.length
  await session.submit({ text: '/ask-me', clientMessageId: 'c-ask' }, 'turn')
  const select = await log.waitFor('question.request')
  check('a select dialog becomes a single-choice question', select.request.questions[0]?.question === 'Pick a fruit' && select.request.questions[0]?.options.map(option => option.label).join(',') === 'apple,pear' && select.request.questions[0]?.hideCustomInput === true, select.request)
  check('an open dialog reads as requires-action', session.status === 'requires-action')
  session.capabilities.questions!.respond(select.request.requestId, { answers: [{ selected: ['pear'] }] })
  const confirm = await log.waitFor('question.request', event => event.request.requestId !== select.request.requestId)
  check('a confirm dialog offers yes and no', confirm.request.questions[0]?.options.map(option => option.label).join(',') === 'Yes,No' && confirm.request.questions[0]?.detail === 'You picked pear', confirm.request)
  session.capabilities.questions!.respond(confirm.request.requestId, { answers: [{ selected: ['Yes'] }] })
  const input = await log.waitFor('question.request', event => event.request.requestId !== confirm.request.requestId && event.request.requestId !== select.request.requestId)
  check('an input dialog is a free-text question', input.request.questions[0]?.options.length === 0 && input.request.questions[0]?.hideCustomInput !== true, input.request)
  session.capabilities.questions!.respond(input.request.requestId, { answers: [{ selected: [], custom: 'Bob' }] })
  const notice = await log.waitFor('notice', event => event.text.startsWith('picked='))
  check('the extension got every answer', notice.text === 'picked=pear ok=true name=Bob', notice.text)
  check('an extension command records no user message', !log.since(mark).some(event => event.type === 'user.message'))

  // ── Thinking level and models ──
  const levels = session.capabilities.effort!.levels().map(level => level.id)
  check('thinking levels come from pi', levels.includes('low') && levels.includes('high'), levels)
  await session.capabilities.effort!.set('low')
  check('a thinking level switch is read back', session.capabilities.effort!.current() === 'low')
  const models = await session.capabilities.models!.list()
  check('the model list carries the faux model by key', models.some(model => model.id === 'faux/faux-1' && model.description === 'faux'), models)
  const commands = await session.capabilities.commands!.list()
  check('the extension command is listed', commands.some(command => command.name === 'ask-me'), commands)

  // ── An interrupt ──
  mark = log.events.length
  await session.submit({ text: 'slow please', clientMessageId: 'c-slow' }, 'turn')
  await log.waitFor('assistant.delta')
  const receipt = await session.cancel('user')
  check('the cancel is confirmed', receipt.outcome === 'confirmed', receipt)
  const cut = await log.waitFor('turn.end', event => event.turn > (end?.type === 'turn.end' ? end.turn : 0), 20_000, mark)
  check('the interrupted turn ends as interrupted', cut.reason.kind === 'interrupted', cut.reason)
  const partial = log.since(mark).find(event => event.type === 'assistant.message' || event.type === 'assistant.attempt.end')
  check('the cut reply is kept as interrupted (or dropped as aborted)', partial !== undefined && ((partial.type === 'assistant.message' && partial.interrupted === true) || (partial.type === 'assistant.attempt.end' && partial.outcome === 'aborted')), partial)

  // ── A steer joins the running turn ──
  mark = log.events.length
  await session.submit({ text: 'use slow tool now', clientMessageId: 'c-slowtool' }, 'turn')
  await log.waitFor('tool.call')
  await session.submit({ text: 'also this', clientMessageId: 'c-steer' }, 'steer')
  const queued = await log.waitFor('pending.changed', event => event.items.some(item => item.id === 'c-steer'), 20_000, mark)
  check('a steer is a pending item while pi holds it', queued.items[0]?.placement === 'steer', queued)
  const steered = await log.waitFor('user.message', event => event.id === 'c-steer', 30_000, mark)
  const claim = log.since(mark).find(event => event.type === 'pending.changed' && (event.claimed ?? []).includes('c-steer'))
  check('the steer is claimed when pi records it', claim !== undefined)
  const steerEnd = await log.waitFor('turn.end', event => event.turn >= (steered.turn ?? 0), 30_000, mark)
  const steerTurn = log.since(mark)
  check('the steer joined the running turn', steerTurn.filter(event => event.type === 'turn.start').length === 1 && steered.turn === steerEnd.turn, { turns: steerTurn.filter(event => event.type === 'turn.start').length, steered: steered.turn, end: steerEnd.turn })

  // ── Fork and rewind (written files are opened by real pi below) ──
  const forked = await session.capabilities.fork!.fork(undefined, 'Forked copy')
  check('/fork makes a new pi session, the live one untouched', forked.backendId === 'pi' && forked.sessionId !== sessionId && session.ref.sessionId === sessionId)
  const rewound = await session.capabilities.rewind!.rewind('c-slow', 'conversation')
  check('a rewind from a live row (client id) makes a new session', rewound.kind === 'rewound' && rewound.session.sessionId !== sessionId, rewound)
  const refused = await session.capabilities.rewind!.rewind('c-slow', 'files')
  check('a file rewind is refused (pi keeps no snapshots)', refused.kind === 'refused')

  await session.dispose()
  check('dispose ends the session', session.status === 'disposed')

  const prompts = async (id: string): Promise<{ users: string[]; title: string | undefined }> => {
    const opened = await openPiBackendSession({ kind: 'resume', sessionId: id }, host)
    try {
      const history = await opened.history()
      const ready: AgentEvent[] = []
      opened.subscribe(batch => { ready.push(...batch) })
      await new Promise(resolve => setTimeout(resolve, 20))
      const readyEvent = ready.find((event): event is Extract<AgentEvent, { type: 'session.ready' }> => event.type === 'session.ready')
      return {
        users: history.filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message' && event.source === 'user').map(event => event.text),
        title: readyEvent?.title,
      }
    } finally {
      await opened.dispose()
    }
  }
  const forkView = await prompts(forked.sessionId)
  check('real pi opens the fork: every prompt, and its title', forkView.users.join('|') === 'use tool please|slow please|use slow tool now|also this' && forkView.title === 'Forked copy', forkView)
  const rewindView = await prompts(rewound.kind === 'rewound' ? rewound.session.sessionId : '')
  check('real pi opens the rewind: the conversation before the picked message', rewindView.users.join('|') === 'use tool please', rewindView)

  // ── The offline catalog and a resume ──
  const rows = await piBackend.catalog!.list({ cwd: home.cwd })
  const row = rows.find(candidate => candidate.id === sessionId)
  check('the catalog lists the session by its opening prompt', row?.title.text === 'use tool please' && row.title.source === 'prompt' && row.hasPrompt && row.cwd === home.cwd, row)
  const preview = await piBackend.catalog!.preview!(sessionId, { cwd: home.cwd })
  check('the preview ends with the newest exchange', preview.at(-1)?.role === 'assistant' && preview.some(entry => entry.text === 'also this'), preview)
  resumed = await openPiBackendSession({ kind: 'resume', sessionId }, host)
  const history = await resumed.history()
  const users = history.filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message' && event.source === 'user').map(event => event.text)
  check('the replay restores every prompt in order', users.join('|') === 'use tool please|slow please|use slow tool now|also this', users)
  check('the replay restores the tool cards', history.some(event => event.type === 'tool.call' && event.name === 'bash') && history.some(event => event.type === 'tool.result' && event.presentation?.card === 'terminal'))
  check('the replay closes its turns', history.filter(event => event.type === 'turn.start').length === history.filter(event => event.type === 'turn.end').length)
  check('the resumed session keeps its id', resumed.ref.sessionId === sessionId)
  const relog = recorder(resumed)
  await resumed.submit({ text: 'think again', clientMessageId: 'c-again' }, 'turn')
  const again = await relog.waitFor('turn.end')
  const replyAgain = relog.events.find(event => event.type === 'assistant.message')
  check('a resumed session continues the conversation', again.reason.kind === 'completed' && replyAgain?.type === 'assistant.message' && replyAgain.blocks.some(block => block.text === 'Thought done.'), replyAgain)
  // A rewind from a replayed row (an entry id) in the resumed session.
  const anchor = history.find((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message' && event.text === 'use slow tool now')?.anchor
  const replayRewind = await resumed.capabilities.rewind!.rewind(anchor ?? '', 'conversation')
  await resumed.dispose()
  const replayView = await prompts(replayRewind.kind === 'rewound' ? replayRewind.session.sessionId : '')
  check('a rewind from a replayed row (entry id) cuts at that entry', replayView.users.join('|') === 'use tool please|slow please', replayView)

  // ── The catalog renames and deletes ──
  await piBackend.catalog!.rename!(forked.sessionId, 'Renamed offline', home.cwd)
  check('real pi reads an offline rename', (await prompts(forked.sessionId)).title === 'Renamed offline')
  check('the catalog shows the rename', (await piBackend.catalog!.info!(forked.sessionId, home.cwd))?.title.text === 'Renamed offline')
  await piBackend.catalog!.delete!(forked.sessionId, home.cwd)
  check('a deleted session leaves the catalog', (await piBackend.catalog!.info!(forked.sessionId, home.cwd)) === undefined)
  await assert.rejects(openPiBackendSession({ kind: 'resume', sessionId: 'no-such-session' }, host), /No pi session no-such-session was found/u)
  check('resuming an unknown session fails loudly', true)
  console.log(`verify-pi-live OK (${checks} checks, pi ${executable.version})`)
} finally {
  await session?.dispose().catch(() => undefined)
  await resumed?.dispose().catch(() => undefined)
  home.cleanup()
}
