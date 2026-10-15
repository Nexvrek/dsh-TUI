/**
 * The pi backend (docs/pi-backend.md): detection, opening a session (create
 * or resume) on a `pi --mode rpc` child of its own, the offline catalog read
 * from pi's session files, and the launcher's per-backend session markers.
 *
 * The child runs the user's own `pi` with the user's own agent directory:
 * their settings, models, logins, extensions, skills and prompt templates
 * apply as in pi itself, and sessions are shared with it (`pi --session`
 * opens a session started here). Project-local resources load only for a
 * project pi trusts; RPC mode never asks, so the session asks instead
 * (`session/trust-prompt.ts`), and a session-only answer reaches each later
 * child as `--approve` / `--no-approve`.
 *
 * A resume opens the session file by path: `--session <id>` would make pi ask
 * on stdin about a session of another project (eating the first command),
 * and `--session-id <id>` silently starts a new session when none matches —
 * which is what a restart of a session pi has not saved yet wants.
 */
import { existsSync } from 'node:fs'
import type { AgentBackend, BackendHost, OpenTarget } from '../../agent/backend.js'
import type { AgentSession } from '../../agent/session.js'
import { installPiLocale, piText } from './text.js'
import { MIN_PI_VERSION, PI_BACKEND_ID, PI_BACKEND_LABEL, piResumeCommand, piVersionSupported } from './contract.js'
import { createPiCatalog, findPiSessionFile } from './catalog.js'
import { detectPi } from './detect.js'
import { piAgentDir } from './paths.js'
import { piTrustArgs } from './trust.js'
import { filePiPrefs, memoryPiPrefs, type PiPrefs } from './prefs.js'
import { buildPiEnv, resolvePiExecutable, type PiExecutable } from './rpc/binary.js'
import { spawnPiRpc, type PiRpcSpawnOptions } from './rpc/transport.js'
import { openPiSession } from './session/session.js'

export interface PiOpenOptions {
  readonly executable?: PiExecutable
  readonly env?: NodeJS.ProcessEnv
  readonly prefs?: PiPrefs
  /** Test seam: the process spawner. */
  readonly spawn?: PiRpcSpawnOptions['spawn']
}

/** The host of the most recent detect / open: the catalog's only way to reach
 *  this backend's own directory, and where its copy takes the language from. */
let catalogHost: BackendHost | undefined

const rememberHost = (host: BackendHost): void => {
  catalogHost = host
  installPiLocale(host.locale)
}

const prefsOf = (host: BackendHost): PiPrefs => host.dataDir === undefined ? memoryPiPrefs() : filePiPrefs(host.dataDir, host.debug)

/** pi's arguments for one session: RPC mode, no themes (nothing renders
 *  them), the session file or id to open, and the trust flag. */
export function piRpcArgs(options: { readonly sessionPath?: string; readonly sessionId?: string; readonly trust?: readonly string[] } = {}): string[] {
  const session = options.sessionPath !== undefined ? ['--session', options.sessionPath] : options.sessionId !== undefined ? ['--session-id', options.sessionId] : []
  return ['--mode', 'rpc', '--no-themes', ...session, ...(options.trust ?? [])]
}

/** pi's warning for `--session-id` creating the session: a restart of an
 *  unsaved session means exactly that. */
const SESSION_ID_CREATED = /No project session found with id/u

/** Open (create or resume) a session on its own child. */
export async function openPiBackendSession(target: OpenTarget, host: BackendHost, options: PiOpenOptions = {}): Promise<AgentSession> {
  rememberHost(host)
  const env = options.env ?? process.env
  const executable = options.executable ?? await resolvePiExecutable(env)
  if (executable === undefined) throw new Error(piText('pi-not-installed'))
  if (!piVersionSupported(executable.version)) throw new Error(piText('pi-too-old', { version: executable.version ?? '', min: MIN_PI_VERSION }))
  let cwd = target.kind === 'create' ? target.cwd : target.cwd ?? host.cwd
  let sessionPath: string | undefined
  if (target.kind === 'resume') {
    const found = await findPiSessionFile(target.sessionId, { ...(target.cwd === undefined ? {} : { cwd: target.cwd }), env })
    if (found === undefined) throw new Error(piText('pi-resume-not-found', { id: target.sessionId }))
    if (found.cwd !== '') {
      if (!existsSync(found.cwd)) throw new Error(piText('pi-resume-cwd-missing', { id: target.sessionId, cwd: found.cwd }))
      cwd = found.cwd
    }
    sessionPath = found.path
  }
  const spawnChild = (args: { readonly sessionPath?: string; readonly sessionId?: string }) => spawnPiRpc({
    command: executable.command,
    args: [...executable.prefixArgs, ...piRpcArgs({ ...args, trust: piTrustArgs(cwd) })],
    cwd,
    env: buildPiEnv(env),
    stderr: line => { if (!SESSION_ID_CREATED.test(line)) host.stderr?.(line) },
    debug: host.debug,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  })
  return openPiSession({
    link: spawnChild(sessionPath === undefined ? {} : { sessionPath }),
    respawn: next => spawnChild(next.sessionFile === undefined ? { sessionId: next.sessionId } : { sessionPath: next.sessionFile }),
    executable, target, cwd, env,
    prefs: options.prefs ?? prefsOf(host),
    host: { debug: host.debug, locale: host.locale },
    agentDir: piAgentDir(env),
  })
}

export const piBackend: AgentBackend = {
  id: PI_BACKEND_ID,
  descriptor: { label: PI_BACKEND_LABEL },

  detect: (host: BackendHost) => { rememberHost(host); return detectPi(host) },

  catalog: createPiCatalog({
    cwd: () => catalogHost?.cwd ?? process.cwd(),
    lastUsed: () => {
      const dir = catalogHost?.dataDir
      return dir === undefined ? {} : filePiPrefs(dir).read().lastUsed ?? {}
    },
  }),

  launch: {
    // The launcher asks before a session exists, so this store is built from
    // the host it is handed; a host without a directory keeps nothing.
    sessionPrefs: host => {
      const prefs = prefsOf(host)
      return {
        lastSession: () => prefs.read().lastSession,
        setLastSession: sessionId => { prefs.write({ lastSession: sessionId }) },
        touch: sessionId => { prefs.touch(sessionId) },
        forget: sessionId => { prefs.forget(sessionId) },
      }
    },
    resumeCommand: piResumeCommand,
  },

  open: openPiBackendSession,
}
