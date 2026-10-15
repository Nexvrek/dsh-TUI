/**
 * The pi session catalog, read straight from pi's session files (pi's RPC has
 * no listing command): `<timestamp>_<sessionId>.jsonl`, a `session` header
 * line (`id`, `cwd`, `timestamp`, `parentSession`) and then tree entries
 * (pi's docs/session-format.md). Read-only: nothing here writes pi's store.
 *
 * - Title: the latest `session_info` name (pi's `/name`), else the opening
 *   prompt, else the directory name — what pi's own `/resume` shows.
 * - Activity: the later of the file's mtime and this install's last use.
 * - A large file is read at its head and tail only; a prompt not seen there
 *   leaves `hasPrompt` true (an inconclusive read must stay visible).
 * - Rename appends a `session_info` entry after the file's last entry (pi's
 *   leaf), as pi's own `/name` would; delete moves the file to the trash when
 *   a `trash` command exists and removes it otherwise, as pi's `/resume`
 *   does. Both are the browser's explicit actions on a session no process
 *   here has open (the live session renames through its own child).
 */
import { execFile } from 'node:child_process'
import { type Dirent } from 'node:fs'
import { appendFile, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { SessionCatalog, SessionListScope } from '../../agent/backend.js'
import type { PreviewEntry, SessionSummary } from '../../agent/index.js'
import { piText } from './text.js'
import { freshEntryId } from './session/branch.js'
import { PI_BACKEND_ID } from './contract.js'
import { arr, num, rec, str, text, type Rec } from './narrow.js'
import { piProjectSessionDir, piSessionStore, type PiSessionStore } from './paths.js'

const LIST_LIMIT = 500
const PREVIEW_LIMIT = 6
/** Files above this are read at head and tail only. */
const FULL_READ_BYTES = 8 * 1024 * 1024
const PART_BYTES = 512 * 1024
const FILE_NAME = /^(.+?)_([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/u

/** What one session file says about itself. */
export interface PiSessionFileInfo {
  readonly path: string
  readonly id: string
  readonly cwd: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly bytes: number
  readonly name: string | undefined
  readonly prompt: string | undefined
  readonly hasPrompt: boolean
  readonly model: string | undefined
  readonly parentSession: string | undefined
}

/** The records of a JSONL text (unparseable lines skipped). */
function records(textBody: string): Rec[] {
  const out: Rec[] = []
  for (const line of textBody.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = rec(JSON.parse(line))
      if (value !== undefined) out.push(value)
    } catch { /* a torn or foreign line */ }
  }
  return out
}

/** The text of a message's content (a string or text blocks). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content).map(rec).filter(block => block?.type === 'text').map(block => str(block!.text) ?? '').join('\n')
}

function hasImage(content: unknown): boolean {
  return arr(content).some(block => rec(block)?.type === 'image')
}

/** One line of a title: the first non-empty line, trimmed. */
function firstLine(value: string): string {
  return value.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

/** The id a session file's name carries (`<timestamp>_<id>.jsonl`). */
export function idFromFileName(path: string): string | undefined {
  return FILE_NAME.exec(basename(path))?.[2]
}

/** Read the head and tail of a large file (records cut at the seams are skipped). */
async function readBounded(path: string, size: number): Promise<{ readonly body: string; readonly complete: boolean }> {
  if (size <= FULL_READ_BYTES) return { body: await readFile(path, 'utf8'), complete: true }
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(PART_BYTES)
    const tail = Buffer.alloc(PART_BYTES)
    const headRead = await handle.read(head, 0, PART_BYTES, 0)
    const tailRead = await handle.read(tail, 0, PART_BYTES, size - PART_BYTES)
    return { body: `${head.subarray(0, headRead.bytesRead).toString('utf8')}\n${tail.subarray(0, tailRead.bytesRead).toString('utf8')}`, complete: false }
  } finally {
    await handle.close()
  }
}

/** Summarize one session file; undefined when it is not a pi session. */
export async function readPiSessionFile(path: string): Promise<PiSessionFileInfo | undefined> {
  let size: number
  let mtime: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    size = info.size
    mtime = info.mtimeMs
  } catch {
    return undefined
  }
  let body: string
  let complete: boolean
  try {
    ({ body, complete } = await readBounded(path, size))
  } catch {
    return undefined
  }
  const rows = records(body)
  const header = rows[0]
  if (header?.type !== 'session') return undefined
  const id = text(header.id) ?? idFromFileName(path)
  if (id === undefined) return undefined
  let name: string | undefined
  let prompt: string | undefined
  let promptSeen = false
  let model: string | undefined
  let lastActivity = 0
  for (const entry of rows.slice(1)) {
    if (entry.type === 'session_info') name = str(entry.name)?.trim() || undefined
    else if (entry.type === 'model_change') model = text(entry.modelId) ?? model
    else if (entry.type === 'message') {
      const message = rec(entry.message)
      const at = num(message?.timestamp)
      if (at !== undefined) lastActivity = Math.max(lastActivity, at)
      if (message?.role === 'user') {
        const value = firstLine(contentText(message.content))
        if (value !== '' || hasImage(message.content)) promptSeen = true
        if (prompt === undefined && value !== '') prompt = value
      } else if (message?.role === 'assistant') {
        model = text(message.model) ?? model
      }
    }
  }
  const created = Date.parse(str(header.timestamp) ?? '')
  return {
    path, id,
    cwd: str(header.cwd) ?? '',
    createdAt: Number.isFinite(created) ? created : mtime,
    updatedAt: Math.max(mtime, lastActivity),
    bytes: size,
    name,
    prompt,
    hasPrompt: promptSeen || !complete,
    model,
    parentSession: text(header.parentSession),
  }
}

/** A session file as the browser's row. */
export function piSessionSummary(info: PiSessionFileInfo, lastUsed: Readonly<Record<string, number>> = {}): SessionSummary {
  const parent = info.parentSession === undefined ? undefined : idFromFileName(info.parentSession) ?? basename(info.parentSession)
  return {
    id: info.id,
    backendId: PI_BACKEND_ID,
    kind: parent === undefined ? { kind: 'root' } : { kind: 'fork', parent },
    title: info.name !== undefined ? { text: info.name, source: 'renamed' }
      : info.prompt !== undefined ? { text: info.prompt, source: 'prompt' }
        : { text: basename(info.cwd) || info.id, source: 'fallback' },
    cwd: info.cwd,
    createdAt: info.createdAt,
    updatedAt: Math.max(info.updatedAt, lastUsed[info.id] ?? 0),
    bytes: info.bytes,
    hasPrompt: info.hasPrompt,
    agentPreset: undefined,
    model: info.model,
    label: undefined,
    branch: undefined,
    childCount: 0,
  }
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Every session file path in scope (`cwd` = one project, else all). */
async function sessionPaths(store: PiSessionStore, cwd: string | undefined): Promise<{ readonly paths: string[]; readonly filterCwd: string | undefined }> {
  if (cwd !== undefined) {
    const project = piProjectSessionDir(store, cwd)
    const files = (await listDir(project.dir)).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => join(project.dir, entry.name))
    return { paths: files, filterCwd: project.filterCwd ? resolve(cwd) : undefined }
  }
  if (store.kind === 'flat') {
    return { paths: (await listDir(store.dir)).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => join(store.dir, entry.name)), filterCwd: undefined }
  }
  const paths: string[] = []
  for (const project of await listDir(store.root)) {
    if (!project.isDirectory()) continue
    const dir = join(store.root, project.name)
    for (const entry of await listDir(dir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(join(dir, entry.name))
    }
  }
  return { paths, filterCwd: undefined }
}

/** Newest first by the time in the file name (no stat needed to order). */
function newestFirst(paths: string[]): string[] {
  return paths.sort((a, b) => basename(b).localeCompare(basename(a)))
}

/** Find a session's file by id: the named project first, then every project. */
export async function findPiSessionFile(sessionId: string, options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}): Promise<PiSessionFileInfo | undefined> {
  const store = piSessionStore(options.env)
  const scopes: (string | undefined)[] = options.cwd === undefined ? [undefined] : [options.cwd, undefined]
  for (const cwd of scopes) {
    const { paths } = await sessionPaths(store, cwd)
    for (const path of paths) {
      if (idFromFileName(path) !== sessionId) continue
      const info = await readPiSessionFile(path)
      if (info !== undefined && info.id === sessionId) return info
    }
    // A custom `--session-id` may not match the file-name pattern: read headers.
    for (const path of paths) {
      if (idFromFileName(path) !== undefined) continue
      const info = await readPiSessionFile(path)
      if (info !== undefined && info.id === sessionId) return info
    }
  }
  return undefined
}

/** The trailing exchanges of a session file's active branch, newest last. */
export async function piSessionPreview(path: string, limit = PREVIEW_LIMIT): Promise<PreviewEntry[]> {
  if (limit <= 0) return []
  let size: number
  try { size = (await stat(path)).size } catch { return [] }
  const { body } = await readBounded(path, size)
  const rows = records(body).filter(row => row.type !== 'session')
  const byId = new Map<string, Rec>()
  for (const row of rows) {
    const id = str(row.id)
    if (id !== undefined) byId.set(id, row)
  }
  const branch: Rec[] = []
  const seen = new Set<string>()
  let cursor: Rec | undefined = rows.at(-1)
  while (cursor !== undefined) {
    const id = str(cursor.id)
    if (id === undefined || seen.has(id)) break
    seen.add(id)
    branch.push(cursor)
    const parent = str(cursor.parentId)
    cursor = parent === undefined ? undefined : byId.get(parent)
  }
  const entries: PreviewEntry[] = []
  for (const row of branch.reverse()) {
    const message = rec(row.message)
    if (row.type !== 'message' || (message?.role !== 'user' && message?.role !== 'assistant')) continue
    const body = contentText(message.content).trim()
    const shown = body !== '' ? body : message.role === 'user' && hasImage(message.content) ? piText('pi-preview-image') : ''
    if (shown !== '') entries.push({ role: message.role, text: shown, at: num(message.timestamp) })
  }
  return entries.slice(-limit)
}

/** Name a session the way pi's `/name` does: a `session_info` entry after
 *  the last entry. */
export async function appendPiSessionName(path: string, title: string, now: Date = new Date()): Promise<void> {
  const body = await readFile(path, 'utf8')
  const rows = records(body)
  if (rows[0]?.type !== 'session') throw new Error(`not a pi session file: ${path}`)
  const ids = new Set(rows.map(row => str(row.id) ?? '').filter(id => id !== ''))
  const leaf = str(rows.filter(row => row.type !== 'session').at(-1)?.id) ?? null
  const entry = { type: 'session_info', id: freshEntryId(ids), parentId: leaf, timestamp: now.toISOString(), name: title.trim() }
  await appendFile(path, `${body === '' || body.endsWith('\n') ? '' : '\n'}${JSON.stringify(entry)}\n`)
}

/** Remove a session file: to the trash when a `trash` command exists. */
export async function removePiSessionFile(path: string): Promise<void> {
  const trashed = await new Promise<boolean>(resolve => {
    try {
      execFile('trash', [path], { timeout: 10_000, windowsHide: true }, error => { resolve(error === null) })
    } catch {
      resolve(false)
    }
  })
  if (!trashed) await rm(path, { force: true })
}

export interface PiCatalogDeps {
  cwd(): string
  lastUsed?(): Readonly<Record<string, number>>
  env?(): NodeJS.ProcessEnv
}

export function createPiCatalog(deps: PiCatalogDeps): SessionCatalog {
  const env = (): NodeJS.ProcessEnv => deps.env?.() ?? process.env
  return {
    snapshotKey() {
      const store = piSessionStore(env())
      return JSON.stringify(['pi', store.kind, store.kind === 'flat' ? store.dir : store.root])
    },
    async list(scope: SessionListScope = {}, onPartial?: (rows: readonly SessionSummary[]) => void) {
      const cwd = scope.allProjects === true ? undefined : scope.cwd ?? deps.cwd()
      const { paths, filterCwd } = await sessionPaths(piSessionStore(env()), cwd)
      const used = deps.lastUsed?.() ?? {}
      const rows: SessionSummary[] = []
      let sincePublish = 0
      for (const path of newestFirst(paths)) {
        if (rows.length >= LIST_LIMIT) break
        const info = await readPiSessionFile(path)
        if (info === undefined) continue
        if (filterCwd !== undefined && resolve(info.cwd || '/') !== filterCwd) continue
        rows.push(piSessionSummary(info, used))
        if (onPartial !== undefined && ++sincePublish >= 50) {
          sincePublish = 0
          onPartial([...rows].sort((a, b) => b.updatedAt - a.updatedAt))
        }
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async info(sessionId, cwd) {
      const info = await findPiSessionFile(sessionId, { ...(cwd === undefined ? {} : { cwd }), env: env() })
      return info === undefined ? undefined : piSessionSummary(info, deps.lastUsed?.() ?? {})
    },
    async preview(sessionId, options = {}) {
      const limit = Math.max(0, Math.min(20, options.limit ?? PREVIEW_LIMIT))
      const info = await findPiSessionFile(sessionId, { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: env() })
      return info === undefined ? [] : piSessionPreview(info.path, limit)
    },
    async rename(sessionId, title, cwd) {
      const info = await findPiSessionFile(sessionId, { ...(cwd === undefined ? {} : { cwd }), env: env() })
      if (info === undefined) throw new Error(piText('pi-resume-not-found', { id: sessionId }))
      await appendPiSessionName(info.path, title)
    },
    async delete(sessionId, cwd) {
      const info = await findPiSessionFile(sessionId, { ...(cwd === undefined ? {} : { cwd }), env: env() })
      if (info === undefined) throw new Error(piText('pi-resume-not-found', { id: sessionId }))
      await removePiSessionFile(info.path)
    },
  }
}
