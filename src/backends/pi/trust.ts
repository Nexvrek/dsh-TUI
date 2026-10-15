/**
 * pi's project trust (pi's `core/trust-manager.ts`, `core/project-trust.ts`),
 * which RPC mode never asks about — so this backend asks instead, the way
 * pi's own terminal UI does, and records the answer where pi records it.
 *
 * A project needs trust when its `.pi/` holds settings, MCP config,
 * extensions, skills, prompts, themes or a system prompt, or when it or a
 * parent directory has `.agents/skills` (the user's own `~/.agents/skills`
 * excepted). pi then looks for the nearest decision in
 * `<agent dir>/trust.json` (the directory or a parent), else its
 * `defaultProjectTrust` setting; with the default `ask`, a pi without a
 * terminal UI treats the project as untrusted and says nothing. pi settles
 * trust once, at startup, and keeps it for the process.
 *
 * The choices are pi's own (`getProjectTrustOptions` with the session-only
 * pair). A remembered one is written exactly as pi writes it: the canonical
 * path as key, keys sorted, two-space JSON, under pi's lock — a
 * `trust.json.lock` directory, as `proper-lockfile` makes it (stale after
 * 10s) — so pi reads the answer and a pi running meanwhile is never raced. A
 * session-only one lasts while this process runs, as it does in pi.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { rec } from './narrow.js'
import { piAgentDir } from './paths.js'

/** pi's `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` (`mcp.json` since 1.x). */
const PROJECT_RESOURCES = ['settings.json', 'mcp.json', 'extensions', 'skills', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md'] as const

function canonical(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/** The project resources that make pi ask for trust (`.pi/<entry>`, `<dir>/.agents/skills`). */
export function piTrustResources(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = canonical(env.HOME || homedir())
  const userSkills = join(home, '.agents', 'skills')
  const root = canonical(cwd)
  const found: string[] = PROJECT_RESOURCES.filter(entry => existsSync(join(root, '.pi', entry))).map(entry => join('.pi', entry))
  let dir = root
  for (;;) {
    const skills = join(dir, '.agents', 'skills')
    if (skills !== userSkills && existsSync(skills)) found.push(dir === root ? join('.agents', 'skills') : skills)
    const parent = dirname(dir)
    if (parent === dir) return found
    dir = parent
  }
}

/** Whether pi asks for trust before loading this project's resources. */
export function piProjectNeedsTrust(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return piTrustResources(cwd, env).length > 0
}

function trustFile(env: NodeJS.ProcessEnv): string {
  return join(piAgentDir(env), 'trust.json')
}

/** The store as pi reads it: an object of `true` / `false` / `null`. A file
 *  that is not one throws, as in pi (so a write never replaces it). */
function readTrustStrict(env: NodeJS.ProcessEnv): Record<string, boolean | null> {
  const file = trustFile(env)
  if (!existsSync(file)) return {}
  const data = rec(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')))
  if (data === undefined) throw new Error(`${file} is not an object`)
  const out: Record<string, boolean | null> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value !== true && value !== false && value !== null) throw new Error(`${file}: ${JSON.stringify(key)} is not true, false or null`)
    out[key] = value
  }
  return out
}

function readTrust(env: NodeJS.ProcessEnv): Record<string, boolean | null> {
  try {
    return readTrustStrict(env)
  } catch {
    return {}
  }
}

/** The nearest trust decision for `cwd`, else null. */
export function piTrustDecision(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  const data = readTrust(env)
  let dir = canonical(cwd)
  for (;;) {
    const value = data[dir]
    if (value === true || value === false) return value
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** pi's `defaultProjectTrust` (global settings), `ask` when unset or unreadable. */
function defaultProjectTrust(env: NodeJS.ProcessEnv): 'always' | 'never' | 'ask' {
  try {
    const value = rec(JSON.parse(readFileSync(join(piAgentDir(env), 'settings.json'), 'utf8')))?.defaultProjectTrust
    return value === 'always' || value === 'never' ? value : 'ask'
  } catch {
    return 'ask'
  }
}

/** This process's session-only decisions, by canonical folder. pi keeps one
 *  per process (`projectTrustByCwd`); here every session runs a child of its
 *  own, so each later child is told with `--approve` / `--no-approve`. */
const sessionDecisions = new Map<string, boolean>()

/** The session-only decision for `cwd` in this process, if any. */
export function piSessionTrust(cwd: string): boolean | undefined {
  return sessionDecisions.get(canonical(cwd))
}

/** Record a session-only decision; `undefined` forgets it (a remembered one
 *  in trust.json decides then). */
export function setPiSessionTrust(cwd: string, trusted: boolean | undefined): void {
  if (trusted === undefined) sessionDecisions.delete(canonical(cwd))
  else sessionDecisions.set(canonical(cwd), trusted)
}

/** pi's trust flag for a child started in `cwd` now. */
export function piTrustArgs(cwd: string): string[] {
  const trusted = piSessionTrust(cwd)
  return trusted === undefined ? [] : [trusted ? '--approve' : '--no-approve']
}

/** Whether a child started in `cwd` now loads the project's resources: pi's
 *  own resolution, short of an extension's `project_trust` handler. */
export function piChildTrusted(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const session = piSessionTrust(cwd)
  if (session !== undefined) return session
  if (!piProjectNeedsTrust(cwd, env)) return true
  return piTrustDecision(cwd, env) ?? defaultProjectTrust(env) === 'always'
}

/** True when pi in RPC mode would silently leave this project's resources
 *  out: they need trust, nothing decided it (this process included), and the
 *  default is to ask — where pi's own interface would ask. */
export function piTrustUnsettled(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return piSessionTrust(cwd) === undefined && piProjectNeedsTrust(cwd, env) && piTrustDecision(cwd, env) === null && defaultProjectTrust(env) === 'ask'
}

/** One of pi's trust choices. `updates` are written to trust.json (`null`
 *  removes a key); the session-only choices have none. */
export interface PiTrustChoice {
  readonly id: 'trust' | 'trust-parent' | 'trust-session' | 'deny' | 'deny-session'
  readonly trusted: boolean
  readonly updates: readonly { readonly path: string; readonly decision: boolean | null }[]
  /** The parent folder a `trust-parent` choice trusts. */
  readonly parent?: string
}

/** pi's choices for `cwd`, in pi's order. */
export function piTrustChoices(cwd: string): PiTrustChoice[] {
  const path = canonical(cwd)
  const parent = dirname(path)
  return [
    { id: 'trust', trusted: true, updates: [{ path, decision: true }] },
    ...(parent === path ? [] : [{ id: 'trust-parent' as const, trusted: true, updates: [{ path: parent, decision: true }, { path, decision: null }], parent }]),
    { id: 'trust-session', trusted: true, updates: [] },
    { id: 'deny', trusted: false, updates: [{ path, decision: false }] },
    { id: 'deny-session', trusted: false, updates: [] },
  ]
}

/** pi's lock: a `<file>.lock` directory, stale after 10s (`proper-lockfile`). */
const LOCK_STALE_MS = 10_000

async function withTrustLock<T>(file: string, run: () => T): Promise<T> {
  const lock = `${file}.lock`
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let stale = false
      try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS } catch { stale = true }
      if (stale) { rmSync(lock, { recursive: true, force: true }); continue }
      if (attempt >= 100) throw new Error(`trust store is locked: ${lock}`)
      await new Promise(resolveLater => setTimeout(resolveLater, 50))
    }
  }
  try {
    return run()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Record a remembered choice in pi's trust store, as pi writes it. */
export async function writePiTrust(updates: PiTrustChoice['updates'], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (updates.length === 0) return
  const file = trustFile(env)
  await withTrustLock(file, () => {
    const data = readTrustStrict(env)
    for (const { path, decision } of updates) {
      if (decision === null) delete data[path]
      else data[path] = decision
    }
    const sorted: Record<string, boolean | null> = {}
    for (const key of Object.keys(data).sort()) sorted[key] = data[key]!
    writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  })
}
