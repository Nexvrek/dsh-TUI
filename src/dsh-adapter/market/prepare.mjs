/** Official package operations, isolated from the running application's Loader and events. */
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compareVersions, liveRuntimeProcesses, materializeRecipe, ownedDirectory, PACKAGE,
  packageDirectory, PROFILE, readJson, RESCUE_PROFILE, RUNTIME_BUNDLE, runtimeBundleOrder,
  runtimeStatus, runtimeTemplate,
} from './runtime-profile.mjs'

/** Resolve public management APIs from the same installation that owns the caller. */
export async function managementModules(installAnchor) {
  const require = createRequire(installAnchor)
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const [manager, operations, atomic] = await Promise.all([
    load('@deepseek-ai/dsh-plugin-manager'),
    load('@deepseek-ai/dsh-plugin-manager/operations'),
    load('@deepseek-ai/dsh-atomic-write'),
  ])
  return { PluginManager: manager.default, ...operations, ...atomic }
}

function assertChange(result, stage) {
  if (result.application === 'failed' || result.application === 'cancelled') {
    const log = result.packageResult?.logPath
    throw new Error(`TUI ${stage} ${result.application}${log ? `; diagnostic log: ${log}` : ''}`)
  }
}

/**
 * Prepare one application-owned profile. The outer setup lock differs from the
 * official package.json lock: package operations must acquire the latter themselves.
 */
export async function prepareRuntime({ Context, Loader, source, version, profile = PROFILE, signal, registries, onPhase = () => {} }) {
  if (profile !== PROFILE && profile !== RESCUE_PROFILE) throw new Error('Unsupported TUI profile')
  const dir = join(source.home, 'profiles', profile)
  const owned = ownedDirectory(dir)
  await mkdir(owned, { recursive: true, mode: 0o700 })
  const modules = await managementModules(source.installAnchor)
  const target = {
    ...source, name: profile, dir, patchPath: join(dir, 'cordis.patch.yml'),
    startedBundles: [], overlays: [],
  }
  return modules.withFileLock(join(owned, 'setup.json'), async () => {
    signal?.throwIfAborted()
    let status = runtimeStatus(dir)
    if (status.ready && compareVersions(status.version, version) >= 0) return status
    if (status.version !== undefined && compareVersions(status.version, version) > 0) {
      throw new Error('A newer TUI is installed but incomplete; repair it using that version instead of downgrading')
    }
    if (liveRuntimeProcesses(dir).length > 0) throw new Error('Close the running TUI before preparing or updating its environment')
    const invocation = source.packageManager ?? { command: 'pnpm' }
    if (readJson(join(dir, 'package.json')) === undefined) {
      onPhase('initializing')
      const initialized = await modules.runPluginCommand({ ...target, profile }, ['--version'], {
        ...invocation, execution: 'service', outputBytes: 16384, signal,
        idleTimeoutMs: 600000, activateNewBundles: false,
      })
      if (initialized.exitCode !== 0) throw new Error(`Cannot initialize the TUI profile; diagnostic log: ${initialized.logPath}`)
    }
    const root = new Context()
    root.provide('profileContext', target)
    try {
      await root.plugin(Loader)
      await root.plugin(modules.PluginManager, {
        registry: registries?.registry ?? registries?.resolved ?? undefined,
        fallbackRegistries: registries?.fallbackRegistries ?? [],
      })
      const manager = root.get('pluginManager')
      const requestId = `dsh-tui-prepare-${process.pid}`
      const cancel = () => { void manager.cancelInstall(requestId).catch(() => {}) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        let complete = false
        try { complete = runtimeTemplate(packageDirectory(dir)).manifest.version === version } catch { /* install the compiled artifact */ }
        if (!complete) {
          onPhase('installing-runtime')
          signal?.throwIfAborted()
          const result = await manager.installBundle(`${PACKAGE}@${version}`, { requestId, saveExact: true })
          assertChange(result, 'runtime installation')
        } else {
          assertChange(await manager.setBundleEnabled(PACKAGE, true), 'runtime selection')
        }
        signal?.throwIfAborted()
        if (runtimeTemplate(packageDirectory(dir)).manifest.version !== version) throw new Error('The installed TUI runtime version does not match the requested release')
        onPhase('configuring')
        const recipe = await materializeRecipe(dir, packageDirectory(dir))
        // A stable file: dependency survives pruning or deleting node_modules.
        const manifest = readJson(join(dir, 'package.json'))
        const recorded = manifest.dependencies?.[RUNTIME_BUNDLE]
        const installed = readJson(join(dir, 'node_modules', ...RUNTIME_BUNDLE.split('/'), 'package.json'))
        if (installed?.version !== version || typeof recorded !== 'string'
          || !recorded.startsWith('file:') || resolve(dir, recorded.slice(5)) !== resolve(recipe)) {
          assertChange(await manager.installBundle(`file:${recipe}`, { requestId, saveExact: true }), 'profile configuration')
        }
        // Read again under the shared official writer lock, retaining every user field.
        await modules.withFileLock(join(dir, 'package.json'), async () => {
          signal?.throwIfAborted()
          const current = readJson(join(dir, 'package.json'))
          const previous = current.dsh?.profile?.bundles
          const next = runtimeBundleOrder(previous)
          if (JSON.stringify(previous) !== JSON.stringify(next)) {
            current.dsh.profile.bundles = next
            await modules.saveManifest(dir, current)
          }
        }, { signal, waitMs: 120000 })
        onPhase('verifying')
        // The official no-HMR branch composes the saved bundle/profile/home layers.
        assertChange(await manager.setBundleEnabled(RUNTIME_BUNDLE, true), 'configuration validation')
        status = runtimeStatus(dir)
        if (!status.ready || status.version !== version) throw new Error(status.problem ?? 'The TUI environment did not become ready')
        return status
      } finally { signal?.removeEventListener('abort', cancel) }
    } finally { await root.fiber.dispose() }
  }, { signal, waitMs: 120000 })
}
