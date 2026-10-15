/**
 * pi translators over recorded wire fixtures (real pi 0.87.1 driving the
 * scripted faux model, `scripts/capture-pi-fixtures.ts`) plus the pure
 * helpers around them. No process, no network.
 *
 * - Every fixture's live translation and its replay from `get_entries` settle
 *   to the same transcript (user messages, replies, tool cards, turn ends),
 *   and both keep the projector's lifecycle invariants.
 * - Per scenario: a tool step's cards and live output, thinking blocks, a read
 *   card, a steer joining the running turn, an abort, a compaction
 *   checkpoint, and a refused compaction.
 * - Tool cards (edit argument shapes, bash exit status, grep/find rows), the
 *   version policy, the JSONL framer (U+2028 inside a string, CRLF, torn
 *   chunks) and the npm shim resolver.
 *
 *   node --import tsx/esm scripts/verify-pi-translate.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/agent/events.js'
import { installPiLocale } from '../src/backends/pi/text.js'
import { comparePiVersions, parsePiVersion, piVersionDrift, piVersionSupported } from '../src/backends/pi/contract.js'
import { editsOf, presentPiToolCall, presentPiToolResult } from '../src/backends/pi/translate/presentation.js'
import { createLineSplitter } from '../src/backends/pi/rpc/transport.js'
import { resolveNpmShim } from '../src/backends/pi/rpc/binary.js'
import { activeBranch } from '../src/backends/pi/translate/replay.js'
import { agentEventInvariantViolations } from './lib/agent-event-invariants.js'
import { loadPiWire, piLiveEvents, piReplayEvents, piWireFixtures, settledTranscript } from './lib/pi-translate-harness.js'

installPiLocale(() => 'en')
let checks = 0
const check = (label: string, ok: unknown, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  checks += 1
  console.log(`PASS ${label}`)
}
const ofType = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// ── Every fixture: live = replay, both well-formed ──
const fixtures = piWireFixtures()
check('the recorded fixtures are present', fixtures.length >= 6, fixtures)
for (const name of fixtures) {
  const fixture = loadPiWire(name)
  const live = piLiveEvents(fixture).events
  const replay = piReplayEvents(fixture)
  const liveText = settledTranscript(live)
  const replayText = settledTranscript(replay)
  check(`${name}: live and replay settle to the same transcript`, JSON.stringify(liveText) === JSON.stringify(replayText), { live: liveText, replay: replayText })
  for (const [path, events] of [['live', live], ['replay', replay]] as const) {
    const errors = agentEventInvariantViolations(events)
    check(`${name}: ${path} keeps the lifecycle invariants`, errors.length === 0, errors)
  }
}

// ── Scenarios ──
{
  const { events, ids } = piLiveEvents(loadPiWire('tool-turn.json'))
  const users = ofType(events, 'user.message')
  check('tool-turn: each prompt is claimed by its client id', users.map(event => event.id).join(',') === ids.map(id => id.id).join(',') && users[0]?.text === 'use tool please', users.map(event => [event.id, event.text]))
  const starts = ofType(events, 'turn.start')
  check('tool-turn: each turn names the message that opened it', starts.length === 2 && starts[0]?.userMessageId === 'c1' && starts[1]?.userMessageId === 'c2', starts)
  const call = ofType(events, 'tool.call')[0]
  check('tool-turn: the bash call is a terminal card titled by its command', call?.name === 'bash' && call.presentation !== undefined && 'card' in call.presentation && call.presentation.card === 'terminal' && call.presentation.title === 'echo hello-from-tool', call)
  const output = ofType(events, 'tool.output').map(event => event.text).join('')
  check('tool-turn: live output streams before the result', output === 'hello-from-tool\n' && events.findIndex(event => event.type === 'tool.output') < events.findIndex(event => event.type === 'tool.result'), output)
  const result = ofType(events, 'tool.result')[0]
  check('tool-turn: the result card carries the output and exit code 0', result?.presentation?.card === 'terminal' && result.presentation.exitCode === 0 && result.presentation.output === 'hello-from-tool\n', result?.presentation)
  const replies = ofType(events, 'assistant.message')
  check('tool-turn: thinking is a reasoning block of its step', replies[0]?.blocks.length === 1 && replies[0].blocks[0]?.type === 'reasoning' && replies[0].blocks[0].text === 'I should run a command.', replies[0])
  check('tool-turn: the second turn thinks then answers', replies[2]?.blocks.map(block => block.type).join(',') === 'reasoning,text', replies[2])
  const deltas = ofType(events, 'assistant.delta')
  check('tool-turn: deltas stream text, reasoning and tool arguments', ['text', 'reasoning', 'tool-args'].every(kind => deltas.some(event => event.delta.kind === kind)))
  const argDelta = deltas.find(event => event.delta.kind === 'tool-args' && event.delta.name === 'bash')
  check('tool-turn: a tool-call block names its call id', argDelta?.delta.kind === 'tool-args' && argDelta.delta.callId === call?.callId, argDelta)
}
{
  const events = piReplayEvents(loadPiWire('read-file.json'))
  const result = ofType(events, 'tool.result')[0]
  check('read-file: a read result is a read card with the file text', result?.presentation?.card === 'read' && result.presentation.path === 'note.txt' && result.text.includes('a note for the read tool'), result)
  check('read-file: the replayed user message uses its entry id as anchor', ofType(events, 'user.message').every(event => event.id === event.anchor && /^[0-9a-f-]+$/u.test(event.id)))
}
{
  const { events } = piLiveEvents(loadPiWire('steer.json'))
  const users = ofType(events, 'user.message')
  check('steer: the steering message joins the running turn', ofType(events, 'turn.start').length === 1 && users.length === 2 && users[1]?.text === 'also this' && users[1]?.turn === users[0]?.turn, users)
  check('steer: the steer comes after the tool result', events.findIndex(event => event.type === 'user.message' && event.text === 'also this') > events.findIndex(event => event.type === 'tool.result'))
  const replay = piReplayEvents(loadPiWire('steer.json'))
  check('steer: the replay keeps it in the same turn', ofType(replay, 'turn.start').length === 1)
}
{
  const { events } = piLiveEvents(loadPiWire('abort.json'))
  const ends = ofType(events, 'turn.end')
  check('abort: the aborted run ends its turn as aborted, the next one completes', ends.map(event => event.reason.kind).join(',') === 'aborted,completed', ends.map(event => event.reason))
  const cut = ofType(events, 'assistant.message')[0]
  const attemptEnd = ofType(events, 'assistant.attempt.end')[0]
  check('abort: the cut reply keeps what streamed, marked interrupted', (cut?.interrupted === true && cut.blocks.some(block => (block.text ?? '').startsWith('slow'))) || attemptEnd?.outcome === 'aborted', { cut, attemptEnd })
}
{
  const { events } = piLiveEvents(loadPiWire('compact.json'))
  const end = ofType(events, 'compaction.end')[0]
  check('compact: the manual compaction brackets and succeeds', ofType(events, 'compaction.start')[0]?.trigger === 'manual' && end?.ok === true, end)
  const summary = ofType(events, 'user.message').find(event => event.source === 'compaction')
  check('compact: the summary becomes the checkpoint row, outside any turn', summary !== undefined && summary.text.startsWith('echo:') && summary.turn === undefined, summary)
  const replay = ofType(piReplayEvents(loadPiWire('compact.json')), 'user.message').find(event => event.source === 'compaction')
  check('compact: the replay restores the same checkpoint', replay?.text === summary?.text)
}
{
  const { events } = piLiveEvents(loadPiWire('compact-refused.json'))
  const end = ofType(events, 'compaction.end')[0]
  check('compact-refused: a refused compaction ends not ok with pi\'s reason', end?.ok === false && (end.error ?? '').includes('Nothing to compact'), end)
  check('compact-refused: no checkpoint row is invented', !ofType(events, 'user.message').some(event => event.source === 'compaction'))
}

// ── Branch selection ──
{
  const entries = [
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'one', timestamp: 1 } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }], stopReason: 'stop', timestamp: 2 } },
    { type: 'message', id: 'c', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'kept' }], stopReason: 'stop', timestamp: 3 } },
  ]
  check('replay follows the leaf\'s branch only', activeBranch(entries, 'c').map(entry => entry.id).join(',') === 'a,c')
  check('without a leaf id the last entry is the leaf', activeBranch(entries, undefined).map(entry => entry.id).join(',') === 'a,c')
  check('a null leaf is an empty branch', activeBranch(entries, null).length === 0)
}

// ── Tool cards ──
{
  check('edit: the array form', editsOf({ edits: [{ oldText: 'a', newText: 'b' }] }).length === 1)
  check('edit: a JSON-string array', editsOf({ edits: '[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]' }).length === 2)
  check('edit: a single edit object', editsOf({ edits: { oldText: 'a', newText: 'b' } }).length === 1)
  check('edit: the legacy top-level pair', editsOf({ oldText: 'a', newText: 'b' }).length === 1)
  const editCall = presentPiToolCall('edit', { path: '/workspace/project/src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, '/workspace/project')
  check('edit call: a diff card with a cwd-relative title', editCall !== undefined && 'card' in editCall && editCall.card === 'diff' && editCall.title === 'src/a.ts', editCall)
  const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n'
  const editResult = presentPiToolResult('edit', { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, { isError: false, text: 'ok', details: { diff: '', patch } }, '/workspace/project')
  check('edit result: pi\'s unified patch is the card', editResult?.card === 'diff' && 'patch' in (editResult.diffs[0] ?? {}) && (editResult.diffs[0] as { patch: string }).patch === patch, editResult)
  const failed = presentPiToolResult('bash', { command: 'false' }, { isError: true, text: 'boom\n\nCommand exited with code 3', details: {} }, '/w')
  check('bash: a failing command is a terminal with its exit status', failed?.card === 'terminal' && failed.exitCode === 3 && failed.output === 'boom', failed)
  check('bash: an error without an exit status stays a plain card', presentPiToolResult('bash', { command: 'x' }, { isError: true, text: 'Command terminated without an exit code', details: {} }, '/w') === undefined)
  check('powershell renders like bash', (presentPiToolCall('powershell', { command: 'dir' }, '/w') as { card?: string } | undefined)?.card === 'terminal')
  const grep = presentPiToolResult('grep', { pattern: 'x' }, { isError: false, text: 'a.ts:3: x = 1\nb.ts:9: y(x)\n\n[100 matches limit reached]', details: { matchLimitReached: 100 } }, '/w')
  check('grep: rows become matches, the limit marks truncation', grep?.card === 'search' && grep.shape === 'matches' && grep.total === 2 && grep.truncated, grep)
  const find = presentPiToolResult('find', { pattern: '*.ts' }, { isError: false, text: 'a.ts\nsrc/b.ts\n', details: {} }, '/w')
  check('find: rows become paths', find?.card === 'search' && find.shape === 'paths' && find.paths.join(',') === 'a.ts,src/b.ts', find)
  check('an unknown tool is the plain card', presentPiToolCall('mcp_thing', {}, '/w') === undefined)
}

// ── Version policy ──
{
  check('parse: pi prints a bare version', parsePiVersion('0.87.1\n') === '0.87.1')
  check('compare: numeric, not lexical', (comparePiVersions('0.100.0', '0.99.9') ?? 0) > 0)
  check('supported: the minimum and above', piVersionSupported('0.84.4') && piVersionSupported('1.2.0') && !piVersionSupported('0.84.3'))
  check('supported: an unreadable version is not refused', piVersionSupported(undefined))
  check('drift: the validated line is clean', piVersionDrift('0.87.1') === undefined && piVersionDrift('0.87.5') === undefined)
  check('drift: another line is reported', piVersionDrift('1.2.0') === '1.2.0' && piVersionDrift('0.86.0') === '0.86.0')
}

// ── JSONL framing ──
{
  const lines: string[] = []
  const split = createLineSplitter(line => { lines.push(line) })
  const record = JSON.stringify({ type: 'message_update', text: 'a\u2028b\u2029c' })
  split.push(record.slice(0, 10))
  split.push(`${record.slice(10)}\r\n{"type":"x"`)
  split.push('}\n')
  check('framing: only LF ends a record (U+2028 stays inside, CR is stripped, chunks join)', lines.length === 2 && (JSON.parse(lines[0]!) as { text: string }).text === 'a\u2028b\u2029c' && lines[1] === '{"type":"x"}', lines)
  split.push('{"type":"tail"}')
  split.flush()
  check('framing: a last record without LF is flushed at end', lines[2] === '{"type":"tail"}')
}

// ── npm shim resolution ──
{
  const files = new Map<string, string>([
    ['C:\\npm\\pi.cmd', '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n'],
    ['C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js', '#!/usr/bin/env node'],
  ])
  const io = { platform: 'win32', exists: (path: string) => files.has(path), read: (path: string) => files.get(path) }
  check('shim: a Windows npm shim resolves to its script', resolveNpmShim('C:\\npm\\pi.cmd', io) === 'C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js')
  check('shim: an unrelated shim resolves to nothing', resolveNpmShim('C:\\npm\\other.cmd', { ...io, read: () => '@ECHO off' }) === undefined)
}

console.log(`verify-pi-translate OK (${checks} checks)`)
