/**
 * The `pi` executable and the environment its RPC child runs in.
 *
 * - Executable: `DSH_TUI_PI_EXECUTABLE` (taken as given, so a typo fails
 *   loudly) → the first `pi` on PATH whose `--version` answers → not
 *   installed. pi's npm bin is a Node script (`dist/bundle/cli.js` with a
 *   `node` shebang): on POSIX it is spawned as is; on Windows the npm shim
 *   (`pi.cmd`/`pi.ps1`) is resolved to that script and run with this Node, so
 *   `cmd.exe` never reparses a session path argument.
 * - Environment: `process.env` minus what a parent pi session exports to its
 *   bash tool (dsh-tui may itself run inside one, and the child must not
 *   believe it is that session's tool process). The user's own pi settings
 *   (`PI_CODING_AGENT_DIR`, provider keys, `PI_OFFLINE`, …) pass through.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { parsePiVersion } from '../contract.js'

/** Where the executable came from (`/doctor`). */
export type PiExecutableSource = 'env' | 'path'

export interface PiExecutable {
  /** What the user would recognize (`/doctor`): the resolved path. */
  readonly path: string
  readonly source: PiExecutableSource
  /** What is actually spawned: the path itself, or this Node for a script
   *  behind a Windows npm shim. */
  readonly command: string
  /** Arguments in front of pi's own (the script path for a resolved shim). */
  readonly prefixArgs: readonly string[]
  readonly version?: string
}

/** Variables a parent pi session exports to its bash tool processes. */
const SCRUBBED: readonly string[] = ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'PI_CODING_AGENT']

/** Whether a variable is one the child must not inherit. */
export function scrubbedPiVariable(name: string): boolean {
  return SCRUBBED.includes(name.toUpperCase())
}

/** The RPC child environment. */
export function buildPiEnv(base: NodeJS.ProcessEnv = process.env, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || scrubbedPiVariable(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/** The JS entry behind an npm `pi` shim (`pi.cmd`, `pi.ps1`, the sh script),
 *  or undefined. Pure over its I/O seams (unit-tested with a fake tree). */
export function resolveNpmShim(shim: string, io: {
  readonly platform: string
  readonly exists: (path: string) => boolean
  readonly read: (path: string) => string | undefined
}): string | undefined {
  const paths = io.platform === 'win32' ? win32 : posix
  const shimDir = paths.dirname(shim)
  const text = io.read(shim)
  const pattern = /["']([^"'\r\n]*@earendil-works[\\/]pi-coding-agent[\\/][^"'\r\n]*\.js)["']|(\S*@earendil-works[\\/]pi-coding-agent[\\/]\S*\.js)/iu
  const match = text === undefined ? null : pattern.exec(text)
  const named = (match?.[1] ?? match?.[2])?.replace(/%~?dp0%?|\$\{?basedir\}?|\$PSScriptRoot/giu, shimDir)
  // The npm layout next to the shim is only a guess for pi's own shim: any
  // other launcher in that directory must stay what it is.
  const isPiShim = /^pi(?:\.cmd|\.bat|\.ps1)?$/iu.test(paths.basename(shim))
  const candidates = [
    ...(named === undefined ? [] : [paths.resolve(shimDir, named)]),
    ...(isPiShim ? [
      paths.join(shimDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      paths.join(shimDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    ] : []),
  ]
  return candidates.find(candidate => io.exists(candidate))
}

/** How to spawn a resolved path: a Windows npm shim runs its script with
 *  this Node; everything else (a POSIX script, a native binary) as is. */
export function spawnTarget(path: string): { readonly command: string; readonly prefixArgs: readonly string[] } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat|ps1)$/iu.test(path)) return { command: path, prefixArgs: [] }
  const script = resolveNpmShim(path, {
    platform: process.platform,
    exists: existsSync,
    read: file => { try { return readFileSync(file, 'utf8').slice(0, 64 * 1024) } catch { return undefined } },
  })
  return script === undefined ? { command: path, prefixArgs: [] } : { command: process.execPath, prefixArgs: [script] }
}

/** Run `<executable> --version` (bounded); the parsed version or undefined. */
export function readPiVersion(target: { readonly command: string; readonly prefixArgs: readonly string[] }, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const shim = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(target.command)
  return new Promise(resolve => {
    try {
      execFile(shim ? (process.env.ComSpec ?? 'cmd.exe') : target.command, shim ? ['/d', '/s', '/c', `"${target.command}" --version`] : [...target.prefixArgs, '--version'], {
        timeout: 15_000,
        windowsHide: true,
        env: buildPiEnv(env, { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }),
      }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return }
        resolve(parsePiVersion(String(stdout)))
      })
    } catch {
      resolve(undefined)
    }
  })
}

/** Every existing `pi` on PATH, in the platform tool's order. */
function whichAll(name: string): Promise<string[]> {
  const win = process.platform === 'win32'
  return new Promise(resolve => {
    try {
      execFile(win ? 'where' : 'which', win ? [name] : ['-a', name], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error !== null && String(stdout).trim() === '') { resolve([]); return }
        resolve(String(stdout).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && existsSync(line)))
      })
    } catch {
      resolve([])
    }
  })
}

/** Resolve the executable and its version; undefined when none is usable. */
export async function resolvePiExecutable(env: NodeJS.ProcessEnv = process.env): Promise<PiExecutable | undefined> {
  const configured = env.DSH_TUI_PI_EXECUTABLE
  if (configured !== undefined && configured !== '') {
    const target = spawnTarget(configured)
    const version = await readPiVersion(target, env)
    return { path: configured, source: 'env', ...target, ...(version === undefined ? {} : { version }) }
  }
  // A candidate that cannot report its version cannot be spawned either
  // (a dead npm shim, an extensionless script on Windows).
  const candidates = await whichAll('pi')
  const ordered = process.platform === 'win32'
    ? [...candidates.filter(path => /\.(?:exe|cmd)$/iu.test(path)), ...candidates.filter(path => !/\.(?:exe|cmd)$/iu.test(path))]
    : candidates
  for (const listed of ordered) {
    const target = spawnTarget(listed)
    const version = await readPiVersion(target, env)
    if (version !== undefined) return { path: listed, source: 'path', ...target, version }
  }
  return undefined
}
