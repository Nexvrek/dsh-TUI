/** Prepare the launcher profile using the installed host, without booting DSH. */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareInstalledRuntime } from './prepare.mjs'
import { PROFILE, readJson, runtimeStatus } from './runtime-profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const profile = process.argv[2] ?? PROFILE
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
if (!runtimeStatus(join(home, 'profiles', profile)).ready) {
  const { findHostDsh, loadHostProfileManagement } = await import(pathToFileURL(join(root, 'lib/types/dsh-adapter/host-dsh.js')).href)
  const found = findHostDsh()
  if (found.packageDir !== undefined) {
    let host
    try { host = await loadHostProfileManagement(found.packageDir) }
    catch { /* The launcher still owns unavailable-host fallback for each backend. */ }
    if (host !== undefined) {
      await prepareInstalledRuntime({
        ...host,
        source: { home, cwd: process.cwd(), installAnchor: join(found.packageDir, 'package.json') },
        version: readJson(join(root, 'package.json')).version, profile,
      })
    }
  }
}
