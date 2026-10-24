/** Strict consumer compilation for the native market modules, including rejected inputs. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// Stay inside this package's scope: the fixture must resolve its real #tui-market imports.
const scratch = mkdtempSync(join(root, 'scripts', '.market-types-'))
try {
  writeFileSync(join(scratch, 'consumer.ts'), `
import { Context } from '@deepseek-ai/cordis'
import { writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { managementModules, prepareRuntime, prepareInstalledRuntime, withRuntimeUpdate } from '#tui-market/prepare'
import { PACKAGE, RUNTIME_BUNDLE, readJson, runtimeStatus, runtimeTemplate, compareVersions, recipeDirectory, liveRuntimeProcesses, type ReadyRuntimeStatus } from '#tui-market/runtime-profile'

const source = { home: '/tmp/home', cwd: '/tmp/work', installAnchor: '/tmp/host/package.json' }
const options = { Context, Loader: undefined, source, version: '1.2.3' }
const prepared: ReadyRuntimeStatus = await prepareRuntime(options)
const installed: ReadyRuntimeStatus = await prepareInstalledRuntime({ ...options, writeProfileManifest })
const version: string = prepared.version
const recipe: string = installed.recipe
const packageName: '@deepseek-harness-tui/dsh-tui' = PACKAGE
const runtimeName: '@deepseek-harness-tui/dsh-tui-runtime' = RUNTIME_BUNDLE
const templateVersion: string = runtimeTemplate('/tmp/package').manifest.version

// @ts-expect-error preparation needs host constructors, locations and a version
prepareRuntime({})
// @ts-expect-error a release version is a string
prepareRuntime({ ...options, version: 42 })
// @ts-expect-error preparation only owns the two TUI profiles
prepareRuntime({ ...options, profile: 'web' })
// @ts-expect-error locations must include cwd and the actual host installation anchor
prepareRuntime({ ...options, source: { home: '/tmp/home' } })
// @ts-expect-error the legacy-capable entry requires the host's public profile writer
prepareInstalledRuntime(options)
prepareRuntime({ ...options, onPhase(phase) {
  const text: string = phase
  // @ts-expect-error phase callbacks do not receive arbitrary untyped values
  const number: number = phase
} })

const status = runtimeStatus('/tmp/profile')
if (status.ready) {
  const readyVersion: string = status.version
  const readyRecipe: string = status.recipe
  // @ts-expect-error ready status still has a typed version
  const badVersion: number = status.version
} else {
  // @ts-expect-error an unready package has not established a valid release version
  const uncheckedVersion: string = status.version
  // @ts-expect-error an unready profile has no verified recipe
  const uncheckedRecipe: string = status.recipe
}
// @ts-expect-error a profile path is a string
runtimeStatus(42)
// @ts-expect-error comparing versions does not accept arbitrary JSON values
compareVersions('1.2.3', 42)
// @ts-expect-error recipe paths require a patch digest string
recipeDirectory('/tmp/profile', '1.2.3', 42)
const raw = readJson('/tmp/package.json')
// @ts-expect-error raw JSON has no trusted manifest shape
raw.version
const owned = readJson<{ version?: string }>('/tmp/owned.json')
const ownedVersion: string | undefined = owned?.version

const modules = await managementModules('/tmp/host/package.json')
const locked: number = await modules.withFileLock('/tmp/lock', async () => 1)
// @ts-expect-error the real host lock API requires an asynchronous operation
modules.withFileLock('/tmp/lock', () => 1)
const optional = await managementModules('/tmp/host/package.json', { optional: true })
// @ts-expect-error absent capabilities must be checked before use
optional.withFileLock('/tmp/lock', async () => 1)
if (optional !== undefined) await optional.withFileLock('/tmp/lock', async () => 1)

const live = await liveRuntimeProcesses('/tmp/profile')
const ownerPid: number = live[0].pid
const ownerPort: number = live[0].port
const ownerToken: string = live[0].token
// @ts-expect-error owner verification is asynchronous
liveRuntimeProcesses('/tmp/profile').filter(() => true)
// @ts-expect-error a lease token is a string
const badOwnerToken: number = live[0].token
const updated: string = await withRuntimeUpdate('/tmp/profile', () => 'updated')
const updatedAsync: number = await withRuntimeUpdate('/tmp/profile', async () => 1, new AbortController().signal)
// @ts-expect-error profile mutation must be a callable operation
withRuntimeUpdate('/tmp/profile', 42)
// @ts-expect-error cancellation requires an AbortSignal
withRuntimeUpdate('/tmp/profile', async () => 1, 'cancel')
`, 'utf8')
  writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, target: 'es2024', module: 'esnext', moduleResolution: 'bundler', types: ['node'] },
    files: ['consumer.ts'],
  }), 'utf8')
  const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.json'), '--listFiles'], { encoding: 'utf8' })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  for (const file of ['consumer.ts', 'market/prepare.d.mts', 'market/runtime-profile.d.mts']) {
    assert.ok(result.stdout.replaceAll('\\', '/').includes(file), `TypeScript did not read ${file}`)
  }
  console.log('market types OK (real package imports, typed host preparation, readiness narrowing and rejected invalid inputs)')
} finally { rmSync(scratch, { recursive: true, force: true }) }
