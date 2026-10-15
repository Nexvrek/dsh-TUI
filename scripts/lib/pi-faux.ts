/**
 * An isolated pi agent directory wired to the scripted faux model
 * (`scripts/fixtures/pi/faux-ext.ts`): `settings.json` names the extension
 * and makes `faux/faux-1` the default model, so a plain `pi --mode rpc` (what
 * the backend spawns) runs real pi with no network and no provider charge.
 * The user's own `~/.pi` is never read or written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAUX_EXTENSION = fileURLToPath(new URL('../fixtures/pi/faux-ext.ts', import.meta.url))

export interface PiFauxHome {
  readonly root: string
  readonly agentDir: string
  readonly cwd: string
  /** The environment the backend should run pi with. */
  readonly env: NodeJS.ProcessEnv
  cleanup(): void
}

export function piFauxHome(prefix = 'pi-faux-', options: { readonly settings?: Readonly<Record<string, unknown>> } = {}): PiFauxHome {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'note.txt'), 'a note for the read tool\n')
  writeFileSync(join(agentDir, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: 'faux-1',
    extensions: [FAUX_EXTENSION, '-builtin:llama.cpp', '-builtin:mcp'],
    quietStartup: true,
    ...options.settings,
  }, null, 2)}\n`)
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }
  delete env.PI_CODING_AGENT_SESSION_DIR
  return { root, agentDir, cwd, env, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
