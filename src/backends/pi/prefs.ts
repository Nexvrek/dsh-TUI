/**
 * The pi backend's persisted user choices (`~/.dsh-tui/backends/pi/prefs.json`):
 * the session a bare `--backend pi --resume` opens, this install's last use
 * of each session, and the per-session `/color`. Model and thinking level are
 * pi's own per-session state (its session file records them), so nothing
 * about them is kept here; dsh-tui never writes pi's settings.
 *
 * Best-effort like every `~/.dsh-tui` preference: a missing or corrupt file
 * reads as "no choice", a failed write goes to the debug log.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../shared/atomic-file.js'
import { rec } from './narrow.js'

export interface PiPrefsData {
  /** The session a bare `dsh-tui --backend pi --resume` opens (the launcher
   *  reads this field directly). */
  readonly lastSession?: string
  /** This install's last use of each session (epoch ms; the newest kept). */
  readonly lastUsed?: Readonly<Record<string, number>>
  readonly colors?: Readonly<Record<string, string>>
}

/** A patch: a value sets the field, `null` clears it. */
export interface PiPrefsPatch {
  readonly lastSession?: string | null
  readonly colors?: Readonly<Record<string, string>>
}

export interface PiPrefs {
  read(): PiPrefsData
  write(patch: PiPrefsPatch): void
  touch(sessionId: string): void
  forget(sessionId: string): void
}

const FILE = 'prefs.json'
const LAST_USED_LIMIT = 200

function parse(parsed: unknown): PiPrefsData {
  const record = rec(parsed)
  if (record === undefined) return {}
  const lastUsed: Record<string, number> = {}
  for (const [id, value] of Object.entries(rec(record.lastUsed) ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) lastUsed[id] = value
  }
  const colors = Object.fromEntries(Object.entries(rec(record.colors) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(-LAST_USED_LIMIT))
  return {
    ...(typeof record.lastSession === 'string' && record.lastSession !== '' ? { lastSession: record.lastSession } : {}),
    ...(Object.keys(lastUsed).length === 0 ? {} : { lastUsed }),
    ...(Object.keys(colors).length === 0 ? {} : { colors }),
  }
}

function patched(current: PiPrefsData, patch: PiPrefsPatch): PiPrefsData {
  const next: Record<string, unknown> = { ...current }
  if (patch.lastSession === null) delete next.lastSession
  else if (patch.lastSession !== undefined) next.lastSession = patch.lastSession
  if (patch.colors !== undefined) next.colors = Object.fromEntries(Object.entries(patch.colors).slice(-LAST_USED_LIMIT))
  return next as PiPrefsData
}

function touched(current: PiPrefsData, sessionId: string, now: number): PiPrefsData {
  const entries = Object.entries({ ...current.lastUsed, [sessionId]: now }).sort((a, b) => b[1] - a[1]).slice(0, LAST_USED_LIMIT)
  return { ...current, lastUsed: Object.fromEntries(entries) }
}

function forgotten(current: PiPrefsData, sessionId: string): PiPrefsData {
  const lastUsed = { ...current.lastUsed }
  delete lastUsed[sessionId]
  const next: Record<string, unknown> = { ...current, lastUsed }
  if (Object.keys(lastUsed).length === 0) delete next.lastUsed
  if (current.lastSession === sessionId) delete next.lastSession
  return next as PiPrefsData
}

/** The file-backed prefs under `<dir>` (the host's `dataDir` for this
 *  backend). The directory is required: a backend never picks a location of
 *  its own under the host's data directory (D2). */
export function filePiPrefs(dir: string, debug: (message: string) => void = () => undefined): PiPrefs {
  const path = join(dir, FILE)
  const read = (): PiPrefsData => {
    try {
      return parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return {}
    }
  }
  const save = (next: PiPrefsData): void => {
    try {
      writeFileAtomic(dir, FILE, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      debug(`pi: prefs write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return {
    read,
    write: patch => { save(patched(read(), patch)) },
    touch: sessionId => { save(touched(read(), sessionId, Date.now())) },
    forget: sessionId => { save(forgotten(read(), sessionId)) },
  }
}

/** An in-memory store (tests, and a host that hands over no directory). */
export function memoryPiPrefs(initial: PiPrefsData = {}): PiPrefs & { readonly data: PiPrefsData } {
  let data: PiPrefsData = { ...initial }
  return {
    get data() { return data },
    read: () => data,
    write(patch) { data = patched(data, patch) },
    touch(sessionId) { data = touched(data, sessionId, Date.now()) },
    forget(sessionId) { data = forgotten(data, sessionId) },
  }
}
