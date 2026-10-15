/**
 * The pi backend against a REAL provider model (costs real usage; not in CI).
 *
 * Cost rule: only a model named by `PI_REAL_MODEL` (`provider/modelId`) whose
 * id reads as a cheap tier (flash, mini, haiku, lite, nano) runs; anything
 * else is refused before pi starts. pi runs in a throwaway agent directory —
 * none of the user's extensions, settings, memories or sessions are read or
 * written — and takes its credential from the environment (the provider's API
 * key variable, e.g. `DEEPSEEK_API_KEY`), which is never printed.
 *
 * Structure is asserted (the event stream, cards, turn ends, claims, files
 * the tools changed); what the model chooses to say is reported, not asserted.
 *
 *   PI_REAL_MODEL=deepseek/deepseek-v4-flash node --import tsx/esm scripts/verify-pi-real.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requested = process.env.PI_REAL_MODEL ?? ''
const slash = requested.indexOf('/')
if (slash <= 0) {
  console.error('verify-pi-real: set PI_REAL_MODEL=<provider>/<modelId> (a cheap model), e.g. deepseek/deepseek-v4-flash')
  process.exit(2)
}
const provider = requested.slice(0, slash)
const modelId = requested.slice(slash + 1)
if (!/flash|mini|haiku|lite|nano/iu.test(modelId)) {
  console.error(`verify-pi-real: refusing ${requested}: only cheap tiers (flash/mini/haiku/lite/nano) run here`)
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'pi-real-'))
const agentDir = join(root, 'agent')
const cwd = join(root, 'project')
mkdirSync(agentDir, { recursive: true })
mkdirSync(cwd, { recursive: true })
// Keeping no recent tokens lets the manual compaction below summarize even a
// short session (pi refuses with "Nothing to compact" otherwise).
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId, quietStartup: true, extensions: ['-builtin:llama.cpp', '-builtin:mcp'], compaction: { keepRecentTokens: 0 } }))
writeFileSync(join(cwd, 'fruit.txt'), 'apple\nbanana\n')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
delete process.env.PI_CODING_AGENT_SESSION_DIR

const { openPiBackendSession, piBackend } = await import('../src/backends/pi/backend.js')
type AgentEvent = import('../src/agent/events.js').AgentEvent
type AgentSession = import('../src/agent/session.js').AgentSession

let checks = 0
const notes: string[] = []
const check = (label: string, ok: unknown, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`)
  checks += 1
  console.log(`PASS ${label}`)
}
const note = (label: string, ok: boolean, detail: string): void => {
  const line = `${ok ? 'OK  ' : 'NOTE'} ${label} — ${detail}`
  if (!ok) notes.push(line)
  console.log(line)
}
const stderr: string[] = []
const host = { cwd, debug: () => undefined, warn: () => undefined, locale: () => 'en' as const, stderr: (line: string) => { stderr.push(line) } }

function recorder(session: AgentSession) {
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  const waitFor = async <T extends AgentEvent['type']>(type: T, test: (event: Extract<AgentEvent, { type: T }>) => boolean = () => true, from = 0, timeoutMs = 120_000): Promise<Extract<AgentEvent, { type: T }>> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = events.slice(from).find((event): event is Extract<AgentEvent, { type: T }> => event.type === type && test(event as Extract<AgentEvent, { type: T }>))
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type} (stderr: ${stderr.slice(-3).join(' | ')})`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  return { events, waitFor }
}
const textOf = (events: readonly AgentEvent[]): string => events.filter((event): event is Extract<AgentEvent, { type: 'assistant.message' }> => event.type === 'assistant.message').flatMap(event => event.blocks.filter(block => block.type === 'text').map(block => block.text ?? '')).join('\n')
const ofType = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

let session: AgentSession | undefined
let resumed: AgentSession | undefined
const started = Date.now()
try {
  session = await openPiBackendSession({ kind: 'create', cwd }, host)
  const log = recorder(session)
  await log.waitFor('session.ready')
  const key = `${provider}/${modelId}`
  const models = await session.capabilities.models!.list()
  check(`the model list offers ${key} under its provider`, models.some(model => model.provider === provider && model.id === modelId), models.map(model => `${model.provider}/${model.id}`).slice(0, 12))
  const onModel = (): boolean => { const current = session!.capabilities.models!.current(); return current.provider === provider && current.model === modelId }
  if (!onModel()) {
    const switched = await session.capabilities.models!.set({ provider, model: modelId })
    check('the session switches to the cheap model', switched.kind === 'switched' && onModel(), switched)
  }
  const levels = session.capabilities.effort!.levels().map(level => level.id)
  console.log(`model ${key}; thinking levels ${levels.join(',')}; current ${session.capabilities.effort!.current()}`)
  if (levels.includes('off')) await session.capabilities.effort!.set('off')

  // ── 1. A plain reply ──
  let mark = log.events.length
  await session.submit({ text: 'Reply with exactly the word pong and nothing else.', clientMessageId: 'r1' }, 'turn')
  let end = await log.waitFor('turn.end', () => true, mark)
  let turn = log.events.slice(mark)
  check('a real turn completes', end.reason.kind === 'completed', end.reason)
  check('the prompt is claimed by its client id', turn.some(event => event.type === 'user.message' && event.id === 'r1') && turn.some(event => event.type === 'pending.changed' && (event.claimed ?? []).includes('r1')))
  check('text streams as deltas before the settled reply', turn.some(event => event.type === 'assistant.delta' && event.delta.kind === 'text') && ofType(turn, 'assistant.message').length >= 1)
  const usage = ofType(turn, 'usage')[0]?.usage
  check('the provider reports token usage', (usage?.input ?? 0) > 0 && (usage?.output ?? 0) > 0, usage)
  check('context usage follows the reply', ofType(turn, 'context.usage').some(event => event.used > 0))
  note('the model answered pong', /pong/iu.test(textOf(turn)), JSON.stringify(textOf(turn).slice(0, 80)))

  // ── 2. A bash tool call ──
  mark = log.events.length
  await session.submit({ text: 'Use the bash tool to run exactly this command: echo dsh-real-check — then reply with the command output only.', clientMessageId: 'r2' }, 'turn')
  end = await log.waitFor('turn.end', () => true, mark)
  turn = log.events.slice(mark)
  const bash = ofType(turn, 'tool.call').find(event => event.name === 'bash')
  check('the model calls bash, shown as a terminal card', bash !== undefined && bash.presentation !== undefined && 'card' in bash.presentation && bash.presentation.card === 'terminal', ofType(turn, 'tool.call').map(event => event.name))
  const bashResult = ofType(turn, 'tool.result').find(event => event.callId === bash?.callId)
  check('the bash result is a terminal card with exit code 0', bashResult?.presentation?.card === 'terminal' && bashResult.presentation.exitCode === 0 && (bashResult.presentation.output ?? '').includes('dsh-real-check'), bashResult?.presentation)
  check('the tool turn completes after the result', end.reason.kind === 'completed' && ofType(turn, 'step.start').length >= 2)
  note('the reply quotes the output', textOf(turn).includes('dsh-real-check'), JSON.stringify(textOf(turn).slice(0, 80)))

  // ── 3. An edit tool call that changes a file ──
  mark = log.events.length
  await session.submit({ text: 'In the file fruit.txt, replace the word apple with pear using the edit tool. Change nothing else, then reply done.', clientMessageId: 'r3' }, 'turn')
  end = await log.waitFor('turn.end', () => true, mark, 180_000)
  turn = log.events.slice(mark)
  const edit = ofType(turn, 'tool.result').find(event => event.presentation?.card === 'diff')
  check('the edit settles as a diff card with pi\'s patch', edit?.presentation?.card === 'diff' && edit.presentation.diffs.some(diff => 'patch' in diff && diff.patch.includes('+pear')), edit?.presentation ?? ofType(turn, 'tool.call').map(event => event.name))
  check('the file really changed', readFileSync(join(cwd, 'fruit.txt'), 'utf8') === 'pear\nbanana\n', readFileSync(join(cwd, 'fruit.txt'), 'utf8'))

  // ── 4. Thinking ──
  const thinking = levels.find(level => level === 'low') ?? levels.find(level => level !== 'off')
  if (thinking !== undefined) {
    await session.capabilities.effort!.set(thinking)
    check(`the thinking level switches to ${thinking}`, session.capabilities.effort!.current() === thinking)
    mark = log.events.length
    await session.submit({ text: 'Is 391 a prime number? Think it through, then answer yes or no.', clientMessageId: 'r4' }, 'turn')
    end = await log.waitFor('turn.end', () => true, mark)
    turn = log.events.slice(mark)
    check('the thinking turn completes', end.reason.kind === 'completed', end.reason)
    const reasoning = ofType(turn, 'assistant.message').some(event => event.blocks.some(block => block.type === 'reasoning' && (block.text ?? '') !== ''))
    note('thinking arrives as reasoning blocks', reasoning, reasoning ? 'reasoning block present' : 'no visible reasoning (the provider may hide it)')
    note('the answer is no (391 = 17 × 23)', /\bno\b/iu.test(textOf(turn)), JSON.stringify(textOf(turn).slice(0, 60)))
    check('reasoning streams as reasoning deltas when the model thinks', !reasoning || turn.some(event => event.type === 'assistant.delta' && event.delta.kind === 'reasoning'))
    await session.capabilities.effort!.set(levels.includes('off') ? 'off' : thinking)
  }

  // ── 5. An interrupt ──
  mark = log.events.length
  await session.submit({ text: 'Write a 600-word story about the sea.', clientMessageId: 'r5' }, 'turn')
  await log.waitFor('assistant.delta', event => event.delta.kind === 'text', mark)
  const receipt = await session.cancel('user')
  end = await log.waitFor('turn.end', () => true, mark)
  check('an interrupt mid-stream is confirmed and ends the turn as interrupted', receipt.outcome === 'confirmed' && end.reason.kind === 'interrupted', { receipt, reason: end.reason })
  turn = log.events.slice(mark)
  check('the cut reply keeps what streamed, marked interrupted', ofType(turn, 'assistant.message').some(event => event.interrupted === true) || ofType(turn, 'assistant.attempt.end').some(event => event.outcome === 'aborted'))

  // ── 6. A steer joins the running turn ──
  mark = log.events.length
  await session.submit({ text: 'Use the bash tool to run exactly: sleep 4; echo slept — then reply with the output.', clientMessageId: 'r6' }, 'turn')
  await log.waitFor('tool.call', event => event.name === 'bash', mark)
  await session.submit({ text: 'Also end your reply with the word BANANA.', clientMessageId: 'r7' }, 'steer')
  const steered = await log.waitFor('user.message', event => event.id === 'r7', mark)
  end = await log.waitFor('turn.end', () => true, mark, 180_000)
  turn = log.events.slice(mark)
  check('the steer was a pending item, then claimed', turn.some(event => event.type === 'pending.changed' && event.items.some(item => item.id === 'r7')) && turn.some(event => event.type === 'pending.changed' && (event.claimed ?? []).includes('r7')))
  check('the steer joined the running turn', ofType(turn, 'turn.start').length === 1 && steered.turn === end.turn, { starts: ofType(turn, 'turn.start').length })
  note('the model honoured the steer', /banana/iu.test(textOf(turn)), JSON.stringify(textOf(turn).slice(-60)))

  // ── 7. Context and compaction ──
  const context = await session.capabilities.context!.usage('summary')
  check('/context reports pi\'s session occupancy', context.used > 0 && (context.max ?? 0) > context.used, context)
  mark = log.events.length
  let compactError: string | undefined
  await session.capabilities.compact!.run().catch((error: unknown) => { compactError = error instanceof Error ? error.message : String(error) })
  const compaction = await log.waitFor('compaction.end', () => true, mark, 180_000)
  if (compactError === undefined) {
    check('a manual compaction succeeds', compaction.ok, compaction)
    check('the summary becomes the checkpoint row', log.events.slice(mark).some(event => event.type === 'user.message' && event.source === 'compaction' && event.text.length > 0))
  } else {
    check('a compaction pi refuses ends not ok with pi\'s reason', !compaction.ok && (compaction.error ?? '').includes(compactError), { compaction, compactError })
    note('the manual compaction ran', false, compactError)
  }
  const compacted = compactError === undefined

  // ── 8. Fork, then resume and continue ──
  const forked = await session.capabilities.fork!.fork()
  const sessionId = session.ref.sessionId
  await session.dispose()
  resumed = await openPiBackendSession({ kind: 'resume', sessionId }, host)
  const history = await resumed.history()
  const prompts = ofType(history, 'user.message').filter(event => event.source === 'user').map(event => event.text)
  check('the resumed history keeps every prompt (and the checkpoint)', prompts.length === 7 && (!compacted || history.some(event => event.type === 'user.message' && event.source === 'compaction')), prompts)
  const relog = recorder(resumed)
  await resumed.submit({ text: 'What file did I ask you to edit earlier? Reply with the file name only.', clientMessageId: 'r8' }, 'turn')
  end = await relog.waitFor('turn.end')
  check('the resumed session continues with a real turn', end.reason.kind === 'completed', end.reason)
  note('the model remembers across compaction and resume', textOf(relog.events).includes('fruit'), JSON.stringify(textOf(relog.events).slice(0, 60)))
  await resumed.dispose()
  const forkView = await openPiBackendSession({ kind: 'resume', sessionId: forked.sessionId }, host)
  const forkPrompts = ofType(await forkView.history(), 'user.message').filter(event => event.source === 'user').length
  await forkView.dispose()
  check('the fork of the real session opens in real pi', forkPrompts === 7, forkPrompts)
  check('the catalog lists both sessions', (await piBackend.catalog!.list({ cwd })).length >= 2)

  console.log(`\nverify-pi-real OK (${checks} checks, ${notes.length} notes, ${Math.round((Date.now() - started) / 1000)}s, model ${key})`)
  for (const line of notes) console.log(line)
} finally {
  await session?.dispose().catch(() => undefined)
  await resumed?.dispose().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}
