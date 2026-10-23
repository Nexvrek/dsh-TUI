/** Prepare the launcher profile using the installed host, without booting DSH. */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareRuntime } from './prepare.mjs'
import { PROFILE, readJson } from './runtime-profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const { findHostDsh, loadHostDsh } = await import(pathToFileURL(join(root, 'lib/types/dsh-adapter/host-dsh.js')).href)
const found = findHostDsh()
if (found.packageDir === undefined) throw new Error('The installed dsh host could not be found')
const host = await loadHostDsh(found.packageDir)
const profile = process.argv[2] ?? PROFILE
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
await prepareRuntime({
  Context: host.Context, Loader: host.Loader,
  source: { home, cwd: process.cwd(), installAnchor: join(found.packageDir, 'package.json') },
  version: readJson(join(root, 'package.json')).version, profile,
})
