/** Coordinate application-owned updates with processes using this profile. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { liveRuntimeProcesses, ownedDirectory, PROFILE, runtimeStatus } from './runtime-profile.mjs'

export const name = 'dsh-tui-runtime-lease'

export async function apply(ctx) {
  const profile = ctx.get('profileContext')
  const dir = profile?.dir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_TUI_PROFILE || PROFILE)
  const anchor = profile?.installAnchor ?? new URL('package.json', ctx.baseUrl)
  const require = createRequire(anchor)
  const { withFileLock, writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
  const owned = ownedDirectory(dir)
  await mkdir(owned, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const record = join(owned, 'running.json')
  const update = operation => withFileLock(join(owned, 'setup.json'), async () => {
    const entries = operation(liveRuntimeProcesses(dir))
    await writeFileAtomic(record, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
  }, { waitMs: 120000 })
  await update(entries => {
    if (!runtimeStatus(dir).ready) throw new Error('The TUI runtime profile is incomplete; run dsh-tui to repair it')
    return [...entries, { pid: process.pid, token }]
  })
  ctx.provide('tuiRuntimeLease', { profileDir: dir })
  ctx.effect(() => () => update(entries => entries.filter(entry => entry.token !== token)), 'dsh-tui runtime lease')
}
