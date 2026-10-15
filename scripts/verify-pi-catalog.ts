/**
 * The pi backend's offline catalog over hand-built pi session files (pi's
 * docs/session-format.md layout) in a temporary agent directory: the
 * per-project tree and the flat stores (`PI_CODING_AGENT_SESSION_DIR`,
 * `settings.json` `sessionDir`), titles and their evidence, forks, files that
 * are not sessions, a large file read at head and tail, previews along the
 * active branch, lookup by id, this install's last-use note; the branch files
 * `/fork` and the rewind write (cuts, title, header, anchors), and the
 * browser's rename and delete. No pi process (`verify-pi-live` has real pi
 * open what these write).
 *
 *   node --import tsx/esm scripts/verify-pi-catalog.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { appendPiSessionName, createPiCatalog, findPiSessionFile, readPiSessionFile } from '../src/backends/pi/catalog.js'
import { readPiHeader, resolveUserEntry, writePiBranch } from '../src/backends/pi/session/branch.js'
import { loadPiWire } from './lib/pi-translate-harness.js'
import { piProjectSessionDir, piSessionDirName, piSessionStore } from '../src/backends/pi/paths.js'
import { installPiLocale } from '../src/backends/pi/text.js'

installPiLocale(() => 'en')
let checks = 0
const check = (label: string, ok: unknown, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  checks += 1
  console.log(`PASS ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
const agentDir = join(root, 'agent')
const alpha = join(root, 'alpha')
const beta = join(root, 'beta')
mkdirSync(alpha, { recursive: true })
mkdirSync(beta, { recursive: true })

type Entry = Record<string, unknown>
let entryCounter = 0
const nextId = (): string => (++entryCounter).toString(16).padStart(8, '0')
const header = (id: string, cwd: string, extra: Entry = {}): Entry => ({ type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd, ...extra })
const message = (parentId: string | null, role: string, content: unknown, timestamp: number, extra: Entry = {}): Entry => ({ type: 'message', id: nextId(), parentId, timestamp: new Date(timestamp).toISOString(), message: { role, content, timestamp, ...extra } })

function writeSession(dir: string, id: string, lines: readonly Entry[], stamp = '2026-10-01T10-00-00-000Z', mtime?: number): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${stamp}_${id}.jsonl`)
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  if (mtime !== undefined) utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}

try {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir }
  delete env.PI_CODING_AGENT_SESSION_DIR
  const store = piSessionStore(env)
  check('the default store is the per-project tree under the agent dir', store.kind === 'tree' && store.root === join(agentDir, 'sessions'), store)
  check('a project directory name is pi\'s encoding of the cwd', piSessionDirName('/home/me/proj') === '--home-me-proj--' && piSessionDirName('C:\\work\\x').endsWith('-work-x--'))
  const alphaDir = piProjectSessionDir(store, alpha).dir
  const betaDir = piProjectSessionDir(store, beta).dir
  const T = Date.parse('2026-10-01T10:00:00.000Z')

  // alpha: a named session, a prompt-titled one, an empty one, a fork
  const u1 = message(null, 'user', 'first prompt\nsecond line', T + 1000)
  const a1 = message(String(u1.id), 'assistant', [{ type: 'text', text: 'reply one' }], T + 2000, { model: 'faux-1', stopReason: 'stop' })
  writeSession(alphaDir, 'named-1', [header('named-1', alpha), { type: 'model_change', id: nextId(), parentId: null, timestamp: '', provider: 'faux', modelId: 'faux-0' }, u1, a1, { type: 'session_info', id: nextId(), parentId: a1.id, timestamp: '', name: '  My Session  ' }], '2026-10-01T10-00-00-000Z', T + 10_000)
  const u2 = message(null, 'user', [{ type: 'text', text: 'prompt titled' }], T + 3000)
  const a2 = message(String(u2.id), 'assistant', [{ type: 'text', text: 'abandoned branch' }], T + 4000, { stopReason: 'stop' })
  const a3 = message(String(u2.id), 'assistant', [{ type: 'text', text: 'kept branch' }], T + 5000, { stopReason: 'stop' })
  const u3 = message(String(a3.id), 'user', [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], T + 6000)
  writeSession(alphaDir, 'prompted-2', [header('prompted-2', alpha), u2, a2, a3, u3], '2026-10-01T11-00-00-000Z', T + 20_000)
  writeSession(alphaDir, 'empty-3', [header('empty-3', alpha)], '2026-10-01T12-00-00-000Z', T + 30_000)
  const parentFile = join(alphaDir, '2026-10-01T10-00-00-000Z_named-1.jsonl')
  writeSession(alphaDir, 'fork-4', [header('fork-4', alpha, { parentSession: parentFile }), message(null, 'user', 'forked prompt', T + 7000)], '2026-10-01T13-00-00-000Z', T + 5000)
  writeFileSync(join(alphaDir, 'notes.jsonl'), '{"type":"not-a-session"}\n')
  writeFileSync(join(alphaDir, 'README.txt'), 'not a session file')
  // beta: one session with a custom id
  writeSession(betaDir, 'my.custom-id', [header('my.custom-id', beta), message(null, 'user', 'beta prompt', T + 8000)], '2026-10-02T09-00-00-000Z', T + 40_000)

  const used: Record<string, number> = {}
  const catalog = createPiCatalog({ cwd: () => alpha, env: () => env, lastUsed: () => used })
  const rows = await catalog.list({ cwd: alpha })
  const byId = Object.fromEntries(rows.map(row => [row.id, row]))
  check('a project listing holds its sessions only', rows.length === 4 && byId['my.custom-id'] === undefined, rows.map(row => row.id))
  check('newest activity first', rows[0]?.id === 'empty-3' && rows.at(-1)?.id === 'fork-4', rows.map(row => [row.id, row.updatedAt]))
  check('pi\'s session name wins, trimmed, as a rename', byId['named-1']?.title.text === 'My Session' && byId['named-1'].title.source === 'renamed', byId['named-1']?.title)
  check('without a name the opening prompt\'s first line stands in', byId['prompted-2']?.title.text === 'prompt titled' && byId['prompted-2'].title.source === 'prompt')
  check('an empty session falls back to the directory and has no prompt', byId['empty-3']?.title.source === 'fallback' && byId['empty-3'].title.text === 'alpha' && byId['empty-3'].hasPrompt === false, byId['empty-3'])
  check('a fork names its parent session', byId['fork-4']?.kind.kind === 'fork' && (byId['fork-4'].kind as { parent: string }).parent === 'named-1', byId['fork-4']?.kind)
  check('the model is the last one recorded', byId['named-1']?.model === 'faux-1' && byId['named-1'].backendId === 'pi', byId['named-1'])
  check('rows carry the header cwd and the file size', byId['named-1']?.cwd === alpha && (byId['named-1']?.bytes ?? 0) > 0)
  const all = await catalog.list({ allProjects: true })
  check('an all-projects listing spans every project', all.length === 5 && all[0]?.id === 'my.custom-id', all.map(row => row.id))
  used['fork-4'] = T + 99_000
  check('this install\'s last use lifts a row', (await catalog.list({ cwd: alpha }))[0]?.id === 'fork-4')

  check('lookup finds a session of another project', (await findPiSessionFile('my.custom-id', { cwd: alpha, env }))?.cwd === beta)
  check('lookup of an unknown id is undefined', (await catalog.info!('nope')) === undefined)
  check('info is the browser row', (await catalog.info!('named-1'))?.title.text === 'My Session')
  const preview = await catalog.preview!('prompted-2', { cwd: alpha })
  check('the preview follows the active branch and shows an image prompt', preview.map(entry => entry.text).join('|') === 'prompt titled|kept branch|[image]', preview)
  check('the preview honors its limit', (await catalog.preview!('prompted-2', { limit: 1 })).length === 1)

  // A large file: header and first prompt at the head, the name at the tail.
  const bigDir = piProjectSessionDir(store, beta).dir
  const filler = message(null, 'assistant', [{ type: 'text', text: 'x'.repeat(1024 * 1024) }], T + 9000, { stopReason: 'stop' })
  const bigLines = [header('big-5', beta), message(null, 'user', 'big prompt', T + 9000), ...Array.from({ length: 10 }, () => filler), { type: 'session_info', id: nextId(), parentId: null, timestamp: '', name: 'Big One' }]
  const bigFile = writeSession(bigDir, 'big-5', bigLines, '2026-10-03T09-00-00-000Z')
  const big = await readPiSessionFile(bigFile)
  check('a large file is read at head and tail', big?.name === 'Big One' && big.prompt === 'big prompt' && big.bytes > 8 * 1024 * 1024, big && { name: big.name, prompt: big.prompt, bytes: big.bytes })
  check('a partial read never claims a session has no prompt', big?.hasPrompt === true)

  // Flat stores.
  const flat = join(root, 'flat')
  writeSession(flat, 'flat-a', [header('flat-a', alpha), message(null, 'user', 'flat alpha', T)])
  writeSession(flat, 'flat-b', [header('flat-b', beta), message(null, 'user', 'flat beta', T)])
  const flatEnv: NodeJS.ProcessEnv = { ...env, PI_CODING_AGENT_SESSION_DIR: flat }
  const flatCatalog = createPiCatalog({ cwd: () => alpha, env: () => flatEnv })
  check('PI_CODING_AGENT_SESSION_DIR is a flat store filtered by header cwd', (await flatCatalog.list({ cwd: alpha })).map(row => row.id).join(',') === 'flat-a')
  check('a flat store lists every project when asked', (await flatCatalog.list({ allProjects: true })).length === 2)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '../flat' }))
  const fromSettings = piSessionStore(env)
  check('settings.json sessionDir is a flat store relative to the agent dir', fromSettings.kind === 'flat' && fromSettings.dir === flat, fromSettings)
  check('the snapshot key names the store', createPiCatalog({ cwd: () => alpha, env: () => env }).snapshotKey!() === JSON.stringify(['pi', 'flat', flat]))

  // ── Branch files (`/fork`, the rewind) over a recorded session ──
  const recorded = loadPiWire('tool-turn.json').entries
  const sourceDir = join(root, 'branch')
  const sourceFile = writeSession(sourceDir, 'source-1', [header('source-1', alpha)])
  const source = { file: sourceFile, entries: recorded.entries, leafId: recorded.leafId }
  const read = (file: string): Entry[] => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Entry)
  const users = (rows: readonly Entry[]): string[] => rows.filter(row => row.type === 'message' && (row.message as Entry).role === 'user').map(row => JSON.stringify((row.message as Entry).content))
  const whole = writePiBranch(source, { kind: 'all' }, { title: 'Copy', now: new Date('2026-10-02T00:00:00.000Z') })
  const allRows = read(whole.file)
  check('a fork header names a new id, the source and the cwd', allRows[0]?.type === 'session' && allRows[0].id === whole.sessionId && allRows[0].parentSession === sourceFile && allRows[0].cwd === alpha && allRows[0].version === 3, allRows[0])
  check('a fork file is named like pi names one', whole.file.endsWith(`2026-10-02T00-00-00-000Z_${whole.sessionId}.jsonl`))
  check('a whole fork keeps every entry, ids and links included', allRows.length === recorded.entries.length + 2 && allRows.slice(1, -1).every((row, index) => JSON.stringify(row) === JSON.stringify(recorded.entries[index])))
  const titled = allRows.at(-1)!
  check('the fork title is a session_info after the last entry', titled.type === 'session_info' && titled.name === 'Copy' && titled.parentId === recorded.leafId, titled)
  check('the copy is a pi session the catalog reads, named and forked', (await readPiSessionFile(whole.file))?.name === 'Copy' && (await readPiSessionFile(whole.file))?.parentSession === sourceFile)
  const firstUser = recorded.entries.find(entry => (entry as Entry).type === 'message' && ((entry as Entry).message as Entry).role === 'user') as Entry
  const secondUser = recorded.entries.filter(entry => (entry as Entry).type === 'message' && ((entry as Entry).message as Entry).role === 'user')[1] as Entry
  const before = read(writePiBranch(source, { kind: 'before', entryId: String(secondUser.id) }).file)
  check('a rewind cuts just before the picked message', users(before).length === 1 && before.at(-1)?.parentId !== undefined && !before.some(row => row.id === secondUser.id))
  const through = read(writePiBranch(source, { kind: 'through', entryId: String(firstUser.id) }).file)
  check('a fork through a message keeps its whole turn, not the next prompt', users(through).length === 1 && through.some(row => row.type === 'message' && (row.message as Entry).role === 'toolResult') && JSON.stringify(through.slice(1)) === JSON.stringify(before.slice(1)))
  const first = read(writePiBranch(source, { kind: 'before', entryId: String(firstUser.id) }).file)
  check('a rewind to the first message still writes a session (no conversation)', first.length >= 1 && users(first).length === 0 && readPiHeader(writePiBranch(source, { kind: 'before', entryId: String(firstUser.id) }).file)?.type === 'session')
  assert.throws(() => writePiBranch(source, { kind: 'before', entryId: 'nope' }), /not on the active branch/u)
  check('a cut at an unknown entry fails loudly', true)
  const transcript = [{ anchor: 'c1', text: 'use tool please' }, { anchor: 'c2', text: 'think hard' }]
  check('an entry id resolves to itself', resolveUserEntry(source, String(secondUser.id), transcript)?.id === secondUser.id)
  check('a client id resolves by position, confirmed by text', resolveUserEntry(source, 'c2', transcript)?.id === secondUser.id)
  check('a misplaced client id falls back to the matching text', resolveUserEntry(source, 'c1', [{ anchor: 'x', text: 'other' }, { anchor: 'c1', text: 'use tool please' }])?.id === firstUser.id)
  check('an unknown anchor resolves to nothing', resolveUserEntry(source, 'missing', transcript) === undefined)

  // ── Rename and delete from the browser (back on the per-project tree) ──
  rmSync(join(agentDir, 'settings.json'))
  const renameFile = writeSession(alphaDir, 'rename-me', [header('rename-me', alpha), message(null, 'user', 'to rename', T)], '2026-10-04T09-00-00-000Z')
  writeFileSync(renameFile, readFileSync(renameFile, 'utf8').trimEnd())
  await appendPiSessionName(renameFile, '  Fresh Name  ')
  const renamedRows = read(renameFile)
  check('a rename appends a session_info after the last entry, newline-safe', renamedRows.length === 3 && renamedRows[2]?.type === 'session_info' && renamedRows[2].name === 'Fresh Name' && renamedRows[2].parentId === renamedRows[1]?.id)
  await catalog.rename!('rename-me', 'Second Name', alpha)
  check('the catalog renames through the file', (await catalog.info!('rename-me', alpha))?.title.text === 'Second Name')
  await catalog.delete!('rename-me', alpha)
  check('the catalog deletes the file', (await catalog.info!('rename-me', alpha)) === undefined)
  await assert.rejects(catalog.rename!('rename-me', 'x', alpha), /No pi session rename-me was found/u)
  check('renaming a missing session fails loudly', true)
  console.log(`verify-pi-catalog OK (${checks} checks)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
