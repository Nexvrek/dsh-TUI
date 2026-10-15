/**
 * Replays a recorded pi wire fixture (`scripts/fixtures/pi/wire/*.json`, from
 * `scripts/capture-pi-fixtures.ts`) through the pi translators: the live path
 * gets every stdout record but the responses, in order, with the prompts the
 * capture sent standing in for the channel's submissions (client ids `c1`,
 * `c2`, …, claimed the way `session/input.ts` claims them); the replay path
 * gets the session's final `get_entries` answer.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '../../src/agent/events.js'
import { createPiContext } from '../../src/backends/pi/translate/core.js'
import { createLiveTranslator } from '../../src/backends/pi/translate/live.js'
import { replayEntries } from '../../src/backends/pi/translate/replay.js'
import type { PiRpcEvent } from '../../src/backends/pi/rpc/transport.js'

export const PI_WIRE_DIR = fileURLToPath(new URL('../fixtures/pi/wire/', import.meta.url))
export const PI_FIXTURE_CWD = '/workspace/project'

type Rec = Record<string, unknown>

export interface PiWireFixture {
  readonly scenario: string
  readonly records: readonly Rec[]
  readonly entries: { readonly entries: readonly unknown[]; readonly leafId: string | null }
}

export function piWireFixtures(): string[] {
  return readdirSync(PI_WIRE_DIR).filter(name => name.endsWith('.json')).sort()
}

export function loadPiWire(name: string): PiWireFixture {
  return JSON.parse(readFileSync(join(PI_WIRE_DIR, name), 'utf8')) as PiWireFixture
}

/** The live translation of a fixture, and the client id each prompt got. */
export function piLiveEvents(fixture: PiWireFixture): { readonly events: AgentEvent[]; readonly ids: readonly { readonly id: string; readonly text: string }[] } {
  let clock = 1_000
  const ctx = createPiContext({ cwd: PI_FIXTURE_CWD, now: () => (clock += 1) })
  const awaiting: { id: string; text: string }[] = []
  const ids: { id: string; text: string }[] = []
  let foreign = 0
  const live = createLiveTranslator(ctx, {
    claimUser(text) {
      let index = awaiting.findIndex(item => item.text === text)
      if (index < 0 && awaiting.length > 0) index = 0
      if (index < 0) return { id: `foreign-${++foreign}`, before: [] }
      return { id: awaiting.splice(index, 1)[0]!.id, before: [] }
    },
  })
  const events: AgentEvent[] = []
  let prompts = 0
  for (const record of fixture.records) {
    const sent = record.sent as Rec | undefined
    if (sent !== undefined) {
      if (sent.type === 'prompt' && typeof sent.message === 'string' && !sent.message.startsWith('/')) {
        const entry = { id: `c${++prompts}`, text: sent.message }
        awaiting.push(entry)
        ids.push(entry)
      }
      continue
    }
    if (record.type === 'response') continue
    events.push(...live.event(record as PiRpcEvent).events)
  }
  return { events, ids }
}

/** The replay translation of a fixture's final entries. */
export function piReplayEvents(fixture: PiWireFixture): AgentEvent[] {
  let clock = 1_000
  const ctx = createPiContext({ cwd: PI_FIXTURE_CWD, now: () => (clock += 1) })
  return replayEntries(ctx, fixture.entries.entries, fixture.entries.leafId)
}

/** The settled transcript of a stream, without ids, times or numbering. */
export function settledTranscript(events: readonly AgentEvent[]): string[] {
  const out: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user.message':
        out.push(`user/${event.source}: ${event.text}`)
        break
      case 'assistant.message':
        out.push(`assistant${event.interrupted === true ? '(interrupted)' : ''}: ${event.blocks.map(block => `${block.type}=${block.text ?? ''}`).join(' | ')}`)
        break
      case 'tool.call':
        out.push(`call ${event.name} ${event.argsJson} ${event.presentation !== undefined && 'card' in event.presentation ? event.presentation.card : '-'}`)
        break
      case 'tool.result':
        out.push(`result ${event.isError ? 'error' : 'ok'} ${event.presentation?.card ?? '-'}: ${event.text}`)
        break
      case 'turn.end':
        out.push(`turn.end ${event.reason.kind}`)
        break
      default:
        break
    }
  }
  return out
}
