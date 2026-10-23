/** Coordinate application-owned updates with processes using this profile. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { liveRuntimeProcesses, ownedDirectory, runtimeStatus } from './runtime-profile.mjs'

export const name = 'dsh-tui-runtime-lease'

export async function apply(ctx) {
  const profile = ctx.get('profileContext')
  // A directly composed development host has no managed profile to lease.
  if (profile === undefined) {
    ctx.provide('tuiRuntimeLease', {})
    return
  }
  const dir = profile.dir
  const require = createRequire(profile.installAnchor)
  let atomicPath
  try { atomicPath = require.resolve('@deepseek-ai/dsh-atomic-write') }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    // Legacy hosts have no managed updater or shared setup lock to coordinate.
    ctx.provide('tuiRuntimeLease', { profileDir: dir })
    return
  }
  const { withFileLock, writeFileAtomic } = await import(pathToFileURL(atomicPath).href)
  if (typeof withFileLock !== 'function' || typeof writeFileAtomic !== 'function') {
    ctx.provide('tuiRuntimeLease', { profileDir: dir })
    return
  }
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
