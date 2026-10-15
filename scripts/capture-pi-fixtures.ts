/**
 * Record pi RPC wire fixtures from a real `pi` running the scripted faux model
 * (`scripts/lib/pi-faux.ts`; no network, no provider charge) into
 * `scripts/fixtures/pi/wire/<scenario>.json`: every stdout record of the run in
 * order (events and responses, the commands sent interleaved as `{ "sent": … }`)
 * plus the session's final `get_entries` answer. `verify-pi-translate` replays
 * them through the live and the replay translators.
 *
 * Sanitized for the tree: the temp directories become `/workspace`, pi's
 * system messages (prompt sections, tool loadouts) and session file paths
 * are dropped, faux usage stays zero.
 *
 *   node --import tsx/esm scripts/capture-pi-fixtures.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { piFauxHome } from './lib/pi-faux.js'

const OUT = fileURLToPath(new URL('./fixtures/pi/wire/', import.meta.url))

interface Scenario {
  readonly name: string
  /** Extra pi settings for this run. */
  readonly settings?: Readonly<Record<string, unknown>>
  /** Commands in order; a prompt waits for `agent_settled` before the next. */
  readonly steps: readonly ({ readonly prompt: string; readonly steerAfterTool?: string; readonly abortAfterDelta?: true } | { readonly command: Record<string, unknown> })[]
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'tool-turn', steps: [{ prompt: 'use tool please' }, { prompt: 'think hard' }] },
  { name: 'read-file', steps: [{ prompt: 'read file note' }] },
  { name: 'steer', steps: [{ prompt: 'use slow tool now', steerAfterTool: 'also this' }] },
  { name: 'abort', steps: [{ prompt: 'slow please', abortAfterDelta: true }, { prompt: 'after abort' }] },
  { name: 'compact', settings: { compaction: { keepRecentTokens: 0 } }, steps: [{ prompt: 'first message' }, { prompt: 'second message' }, { command: { type: 'compact' } }, { prompt: 'after compaction' }] },
  { name: 'compact-refused', steps: [{ prompt: 'only message' }, { command: { type: 'compact' } }] },
]

function sanitize(value: unknown, root: string): unknown {
  const json = JSON.stringify(value, (key, entry: unknown) => {
    if (key === 'sessionFile' || key === 'sections' || key === 'toolsAdded' || key === 'toolsRemoved') return undefined
    if (typeof entry === 'object' && entry !== null && (entry as { role?: unknown }).role === 'system') return { role: 'system', content: '', timestamp: (entry as { timestamp?: unknown }).timestamp }
    return entry
  })
  return JSON.parse(json.split(root).join('/workspace'))
}

async function capture(scenario: Scenario): Promise<void> {
  const home = piFauxHome(`pi-capture-${scenario.name}-`, scenario.settings === undefined ? {} : { settings: scenario.settings })
  const child = spawn('pi', ['--mode', 'rpc', '--no-themes'], { cwd: home.cwd, env: home.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const records: unknown[] = []
  const waiters: ((record: Record<string, unknown>) => boolean)[] = []
  const pending = new Map<string, (record: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.trim() === '') continue
      const record = JSON.parse(line) as Record<string, unknown>
      records.push(record)
      if (record.type === 'response') pending.get(String(record.id))?.(record)
      for (const waiter of [...waiters]) if (waiter(record)) waiters.splice(waiters.indexOf(waiter), 1)
    }
  })
  let seq = 0
  const send = (command: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise(resolve => {
    const id = `cap-${++seq}`
    pending.set(id, resolve)
    records.push({ sent: { ...command, id } })
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
  })
  const until = (test: (record: Record<string, unknown>) => boolean): Promise<void> => new Promise(resolve => { waiters.push(record => { if (!test(record)) return false; resolve(); return true }) })
  try {
    await send({ type: 'get_state' })
    for (const step of scenario.steps) {
      if ('command' in step) { await send(step.command); continue }
      const settled = until(record => record.type === 'agent_settled')
      if (step.steerAfterTool !== undefined) {
        const toolStarted = until(record => record.type === 'tool_execution_start')
        void send({ type: 'prompt', message: step.prompt, streamingBehavior: 'followUp' })
        await toolStarted
        await send({ type: 'prompt', message: step.steerAfterTool, streamingBehavior: 'steer' })
      } else if (step.abortAfterDelta === true) {
        const delta = until(record => record.type === 'message_update')
        void send({ type: 'prompt', message: step.prompt, streamingBehavior: 'followUp' })
        await delta
        await send({ type: 'abort' })
      } else {
        await send({ type: 'prompt', message: step.prompt, streamingBehavior: 'followUp' })
      }
      await settled
    }
    const entries = await send({ type: 'get_entries' })
    mkdirSync(OUT, { recursive: true })
    const file = join(OUT, `${scenario.name}.json`)
    writeFileSync(file, `${JSON.stringify(sanitize({ scenario: scenario.name, records, entries: entries.data }, home.root), null, 1)}\n`)
    console.log(`captured ${scenario.name}: ${records.length} records -> ${file}`)
  } finally {
    child.stdin.end()
    await new Promise(resolve => child.once('exit', resolve))
    home.cleanup()
  }
}

for (const scenario of SCENARIOS) await capture(scenario)
