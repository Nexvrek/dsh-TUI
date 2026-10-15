/**
 * Where pi keeps its state, resolved the way pi resolves it
 * (`packages/coding-agent/src/config.ts`, `core/session-manager.ts`):
 *
 * - agent dir: `PI_CODING_AGENT_DIR` (a leading `~` expanded), else `~/.pi/agent`;
 * - session store: `PI_CODING_AGENT_SESSION_DIR`, else the global
 *   `settings.json` `sessionDir`, else `<agent dir>/sessions/--<cwd>--/`
 *   (one directory per project: the leading separator dropped, `/ \ :`
 *   replaced by `-`). A configured store is flat: every project's files sit
 *   in it and the header's `cwd` tells them apart.
 *
 * A project-level `.pi/settings.json` `sessionDir` is not read here: it only
 * applies to a trusted project, and this backend never decides trust for pi.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { rec, text } from './narrow.js'

/** `~` / `~/x` expanded against the home directory. */
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** pi's agent directory (`~/.pi/agent`). */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR
  return configured !== undefined && configured !== '' ? resolve(expandTilde(configured)) : join(homedir(), '.pi', 'agent')
}

/** Where pi stores sessions: a flat configured store, or the per-project tree. */
export type PiSessionStore =
  | { readonly kind: 'tree'; readonly root: string }
  | { readonly kind: 'flat'; readonly dir: string }

/** The configured session store, as pi itself would resolve it at startup. */
export function piSessionStore(env: NodeJS.ProcessEnv = process.env): PiSessionStore {
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv !== undefined && fromEnv !== '') return { kind: 'flat', dir: resolve(expandTilde(fromEnv)) }
  const agentDir = piAgentDir(env)
  let configured: string | undefined
  try {
    configured = text(rec(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')))?.sessionDir)
  } catch {
    configured = undefined
  }
  if (configured !== undefined) {
    const expanded = expandTilde(configured)
    return { kind: 'flat', dir: isAbsolute(expanded) ? resolve(expanded) : resolve(agentDir, expanded) }
  }
  return { kind: 'tree', root: join(agentDir, 'sessions') }
}

/** The per-project directory name pi derives from a cwd (`--home-me-proj--`). */
export function piSessionDirName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
}

/** The directory holding one project's sessions, and whether its files need a
 *  header `cwd` check (a flat store mixes projects). */
export function piProjectSessionDir(store: PiSessionStore, cwd: string): { readonly dir: string; readonly filterCwd: boolean } {
  return store.kind === 'flat'
    ? { dir: store.dir, filterCwd: true }
    : { dir: join(store.root, piSessionDirName(cwd)), filterCwd: false }
}
