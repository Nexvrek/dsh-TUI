/**
 * `/fork` and the double-Esc rewind for pi: a new session file holding a
 * prefix of the live session's active branch, written in pi's own session
 * format (pi's docs/session-format.md) the way pi's `createBranchedSession`
 * builds one — a new header (`parentSession` naming the source file) and the
 * branch's entries, copied as they are, ids and `parentId` links included.
 *
 * Why not pi's RPC `fork`: it switches the live child to the fork, while
 * `/fork` must leave the live session untouched, and a helper `pi` would load
 * the user's extensions (with whatever they do on a session start or
 * shutdown) just to copy a file. Why not lazily like pi: pi only writes a
 * branch that already holds a conversation, but a rewind to the very first
 * message must still leave a session the channel can open.
 *
 * The entries come from the live child (`get_entries`), so a write pi is
 * making at that moment is never read half done. Entries are not
 * interpreted: label entries on the path stay on it (pi re-chains them; the
 * same labels survive either way).
 */
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic } from '../../shared/atomic-file.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import { activeBranch } from '../translate/replay.js'
import { userText } from '../translate/core.js'

/** How much of a file the header line may take. */
const HEADER_BYTES = 64 * 1024

/** A session file's header line, else undefined. Reads only the head. */
export function readPiHeader(file: string): Rec | undefined {
  let first: string
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(HEADER_BYTES)
    const read = readSync(fd, head, 0, HEADER_BYTES, 0)
    const text = head.subarray(0, read).toString('utf8')
    const newline = text.indexOf('\n')
    first = newline < 0 ? text : text.slice(0, newline)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  try {
    const header = rec(JSON.parse(first))
    return header?.type === 'session' ? header : undefined
  } catch {
    return undefined
  }
}

/** An entry id unused in `taken` (pi's own shape: 8 hex characters). */
export function freshEntryId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = randomUUID().slice(0, 8)
    if (!taken.has(id)) return id
  }
}

export interface PiBranchSource {
  /** The live session's file (it must exist: the session was saved). */
  readonly file: string
  /** `get_entries` of the live child. */
  readonly entries: readonly unknown[]
  readonly leafId: string | null | undefined
}

/** The user-message entries of the active branch, oldest first. */
export function branchUserEntries(source: Pick<PiBranchSource, 'entries' | 'leafId'>): Rec[] {
  return activeBranch(arr(source.entries), source.leafId).filter(entry => entry.type === 'message' && rec(entry.message)?.role === 'user')
}

/**
 * The user entry a transcript anchor names. Replayed rows carry the entry id;
 * live rows carry the channel's client id, matched by position against the
 * branch's user entries (each recorded user message is one row, in order) and
 * confirmed by text, else the nearest entry with the same text.
 */
export function resolveUserEntry(
  source: Pick<PiBranchSource, 'entries' | 'leafId'>,
  anchor: string,
  transcript: readonly { readonly anchor: string; readonly text: string }[],
): Rec | undefined {
  const users = branchUserEntries(source)
  const direct = users.find(entry => str(entry.id) === anchor)
  if (direct !== undefined) return direct
  const index = transcript.findIndex(row => row.anchor === anchor)
  if (index < 0) return undefined
  const text = transcript[index]!.text
  const textOf = (entry: Rec): string => userText(rec(entry.message)?.content)
  if (users[index] !== undefined && textOf(users[index]!) === text) return users[index]
  let best: Rec | undefined
  let distance = Number.POSITIVE_INFINITY
  users.forEach((entry, position) => {
    if (textOf(entry) !== text || Math.abs(position - index) >= distance) return
    best = entry
    distance = Math.abs(position - index)
  })
  return best
}

export type PiBranchCut =
  /** Everything on the branch. */
  | { readonly kind: 'all' }
  /** Everything before this entry (a rewind: the picked message is cut off). */
  | { readonly kind: 'before'; readonly entryId: string }
  /** This user message's turn included: everything before the next user message. */
  | { readonly kind: 'through'; readonly entryId: string }

/** Write the branch prefix as a new session next to the source; its id and path. */
export function writePiBranch(source: PiBranchSource, cut: PiBranchCut, options: { readonly title?: string; readonly now?: Date } = {}): { readonly sessionId: string; readonly file: string } {
  const header = readPiHeader(source.file)
  if (header === undefined) throw new Error(`not a pi session file: ${source.file}`)
  const path = activeBranch(arr(source.entries), source.leafId)
  let end = path.length
  if (cut.kind !== 'all') {
    const at = path.findIndex(entry => str(entry.id) === cut.entryId)
    if (at < 0) throw new Error(`entry ${cut.entryId} is not on the active branch`)
    if (cut.kind === 'before') end = at
    else {
      const next = path.findIndex((entry, index) => index > at && entry.type === 'message' && rec(entry.message)?.role === 'user')
      end = next < 0 ? path.length : next
    }
  }
  const kept: Rec[] = path.slice(0, end)
  const now = options.now ?? new Date()
  const timestamp = now.toISOString()
  if (options.title !== undefined && options.title.trim() !== '') {
    const taken = new Set(kept.map(entry => str(entry.id) ?? ''))
    kept.push({ type: 'session_info', id: freshEntryId(taken), parentId: str(kept.at(-1)?.id) ?? null, timestamp, name: options.title.trim() })
  }
  const sessionId = randomUUID()
  const forkHeader: Rec = { type: 'session', version: header.version ?? 3, id: sessionId, timestamp, cwd: str(header.cwd) ?? '', parentSession: source.file }
  const dir = dirname(source.file)
  const name = `${timestamp.replace(/[:.]/gu, '-')}_${sessionId}.jsonl`
  writeFileAtomic(dir, name, [forkHeader, ...kept].map(line => JSON.stringify(line)).join('\n') + '\n')
  return { sessionId, file: join(dir, basename(name)) }
}
