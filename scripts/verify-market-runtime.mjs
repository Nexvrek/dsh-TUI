/** Native profile preparation regressions; compile first for the existing installer runner. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { apply as applyLease } from '../src/dsh-adapter/market/lease.mjs'
import { managementModules, prepareInstalledRuntime } from '../src/dsh-adapter/market/prepare.mjs'
import { digest, liveRuntimeProcesses, materializeRecipe, ownedDirectory, PACKAGE, packageDirectory, PROFILE, readJson, recipeDirectory, RUNTIME_BUNDLE, runtimeStatus } from '../src/dsh-adapter/market/runtime-profile.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-tui-market-runtime-'))
const put = async (path, content) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}
const home = join(scratch, 'home with spaces 中文')
const dir = join(home, 'profiles', PROFILE)
const packageRoot = packageDirectory(dir)
const version = '1.2.3'
const installAnchor = join(scratch, 'old-host', 'package.json')
const source = { home, cwd: root, installAnchor }
const runWithoutHost = () => promisify(execFile)(process.execPath, [join(root, 'src/dsh-adapter/market/cli.mjs')], {
  env: { ...process.env, DSH_HOME: home, PATH: '', Path: '' },
})
let writes = 0
const prepare = signal => prepareInstalledRuntime({
  source, version, signal,
  writeProfileManifest: async (directory, manifest) => { writes++; await put(join(directory, 'package.json'), manifest) },
})
const template = async patch => {
  await put(join(packageRoot, 'lib/tui-runtime/cordis.patch.yml'), patch)
  await put(join(packageRoot, 'lib/tui-runtime/package.json'), {
    name: RUNTIME_BUNDLE, version, dependencies: { [PACKAGE]: version },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, dshTui: { patchSha256: digest(patch) },
  })
}

try {
  let provided
  await applyLease({ get: () => undefined, provide: (name, value) => { provided = { name, value } },
    get baseUrl() { throw new Error('direct composition must not resolve profile modules') } })
  assert.deepEqual(provided, { name: 'tuiRuntimeLease', value: {} })
  await put(installAnchor, { type: 'module', bin: { dsh: 'cli.mjs' } })
  assert.equal(await managementModules(installAnchor, { optional: true }), undefined)
  await put(join(packageRoot, 'package.json'), {
    name: PACKAGE, version, main: 'lib/types/index.js', dshTui: { runtimeBundle: './lib/tui-runtime' },
  })
  for (const path of ['lib/types/index.js', 'lib/types/dsh-adapter/host-entry.js', 'bin/dsh-tui.js']) await put(join(packageRoot, path), '')
  await template('[]\n')
  const first = await materializeRecipe(dir, packageRoot)
  assert.equal(first, await materializeRecipe(dir, packageRoot), 'same inputs reuse the immutable recipe')
  assert.throws(() => recipeDirectory(dir, version, '../escape'), /digest is invalid/)
  assert.throws(() => recipeDirectory(dir, '../escape', digest('[]')), /exact release version/)

  await put(join(dir, 'package.json'), {
    name: 'user-profile', private: true, dependencies: { [PACKAGE]: version, 'user-bundle': '1.0.0' },
    scripts: { user: 'retained' }, dsh: { profile: { bundles: ['base', PACKAGE, 'user-bundle'], user: true } },
  })
  const userPatch = '- id: dsh-tui\n  config:\n    user: retained\n'
  await put(join(dir, 'cordis.patch.yml'), userPatch)
  await put(join(dirname(installAnchor), 'cli.mjs'), `
    import assert from 'node:assert/strict'
    import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
    import { join, dirname } from 'node:path'
    const [command, flag, profile, add, spec] = process.argv.slice(2)
    assert.deepEqual([command, flag, profile, add], ['plugin', '--profile', ${JSON.stringify(PROFILE)}, 'add'])
    assert.ok(spec.startsWith('file:'))
    const dir = join(process.env.DSH_HOME, 'profiles', profile)
    const installed = join(dir, 'node_modules', ${JSON.stringify(RUNTIME_BUNDLE)})
    await mkdir(dirname(installed), { recursive: true })
    await cp(spec.slice(5), installed, { recursive: true })
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.dependencies[${JSON.stringify(RUNTIME_BUNDLE)}] = spec
    if (!manifest.dsh.profile.bundles.includes(${JSON.stringify(RUNTIME_BUNDLE)})) manifest.dsh.profile.bundles.push(${JSON.stringify(RUNTIME_BUNDLE)})
    await writeFile(path, JSON.stringify(manifest))
    await appendFile(join(process.env.DSH_HOME, 'invocations'), 'installed\\n')
  `)
  assert.equal((await prepare()).ready, true)
  assert.equal(runtimeStatus(dir).ready, true)
  const installed = readJson(join(dir, 'package.json'))
  assert.deepEqual(installed.dsh.profile.bundles, ['base', RUNTIME_BUNDLE, 'user-bundle'])
  assert.equal(installed.scripts.user, 'retained')
  assert.equal(installed.dsh.profile.user, true)
  assert.equal(installed.dependencies['user-bundle'], '1.0.0')
  assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), userPatch)
  assert.equal((await prepare()).ready, true)
  assert.equal(writes, 1, 'a ready legacy profile does not rerun package operations')
  assert.equal(await readFile(join(home, 'invocations'), 'utf8'), 'installed\n')
  await runWithoutHost()
  assert.equal(writes, 1, 'a ready profile does not need host probing before backend fallback')

  await template('- id: rebuilt\n')
  assert.equal(runtimeStatus(dir).ready, false)
  await runWithoutHost()
  assert.equal(runtimeStatus(dir).ready, false, 'without a host, native preparation leaves the backend fallback in charge')
  assert.equal((await prepare()).ready, true, 'a same-version patch rebuild can be prepared')
  const second = runtimeStatus(dir).recipe
  assert.notEqual(second, first)
  assert.equal(await readFile(join(first, 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.equal(writes, 2)
  await applyLease({ get: () => ({ dir, installAnchor }), provide: (name, value) => { provided = { name, value } } })
  assert.deepEqual(provided, { name: 'tuiRuntimeLease', value: { profileDir: dir } })
  assert.equal(existsSync(join(ownedDirectory(dir), 'running.json')), false, 'legacy hosts without atomic APIs do not invent a managed lease')

  const effects = []
  await applyLease({ get: () => ({ dir, installAnchor: join(root, 'package.json') }), provide() {}, effect: register => effects.push(register()) })
  assert.equal(liveRuntimeProcesses(dir).length, 1, 'managed profiles still hold a live lease')
  await template('- id: next-rebuild\n')
  await assert.rejects(prepare(), /Close the running TUI/)
  for (const dispose of effects) await dispose()
  assert.deepEqual(liveRuntimeProcesses(dir), [])
  await assert.rejects(applyLease({ get: () => ({ dir, installAnchor: join(root, 'package.json') }), provide() {}, effect() {} }), /incomplete/)

  await put(join(dirname(installAnchor), 'cli.mjs'), 'process.exit(23)\n')
  await assert.rejects(prepare(), /exit 23/)
  assert.equal(writes, 2, 'a failed package command must not select the new runtime')
  assert.equal(runtimeStatus(dir).ready, false)
  const aborted = new AbortController()
  aborted.abort(new Error('cancelled before preparing'))
  await assert.rejects(prepare(aborted.signal), /cancelled before preparing/)
  assert.equal(writes, 2)
  await put(join(dirname(installAnchor), 'cli.mjs'), `
    import { writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    await writeFile(join(process.env.DSH_HOME, 'started'), '')
    setInterval(() => {}, 1000)
  `)
  const cancellation = new AbortController()
  const cancelling = assert.rejects(prepare(cancellation.signal), /exit 130/)
  const deadline = Date.now() + 10000
  try {
    while (!existsSync(join(home, 'started'))) {
      assert.ok(Date.now() < deadline, 'legacy installer must start before cancellation')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { cancellation.abort(new Error('cancel active preparation')) }
  await cancelling
  assert.equal(writes, 2, 'cancellation must not be reported as a prepared profile')
  assert.equal(runtimeStatus(dir).ready, false)
  console.log('market runtime OK (direct/legacy/managed leases, content-addressed recipes, legacy layer ordering, warm reuse, install failure and cancellation)')
} finally { await rm(scratch, { recursive: true, force: true }) }
