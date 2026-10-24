import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import type * as Operations from '@deepseek-ai/dsh-plugin-manager/operations'
import type { PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { PluginRegistries } from '@deepseek-ai/dsh-plugin-manager/types'
import type * as Atomic from '@deepseek-ai/dsh-atomic-write'
import type { ReadyRuntimeStatus, RuntimeProfileName } from './runtime-profile.mjs'

/** The actual public namespaces loaded from the installation that owns the profile. */
export type RuntimeManagementModules = { PluginManager: typeof PluginManager } & typeof Operations & typeof Atomic

export function managementModules(installAnchor: string, options?: { optional?: false }): Promise<RuntimeManagementModules>
export function managementModules(installAnchor: string, options: { optional?: boolean }): Promise<RuntimeManagementModules | undefined>

/** Preparation needs locations; callers may also supply the rest of their host profile context. */
export type RuntimePreparationSource = Pick<ProfileContext, 'home' | 'cwd' | 'installAnchor'>
  & Partial<Omit<ProfileContext, 'home' | 'cwd' | 'installAnchor' | 'packageManager'>>
  & { packageManager?: Pick<PackageOperationOptions, 'command' | 'args' | 'env'> }

export type RuntimePreparationPhase = 'initializing' | 'installing-runtime' | 'configuring' | 'verifying'

export interface PrepareRuntimeOptions {
  Context: new () => Context
  /** The host's Loader is passed through unchanged; its package is not a runtime peer. */
  Loader: unknown
  source: RuntimePreparationSource
  version: string
  profile?: RuntimeProfileName
  signal?: AbortSignal
  registries?: Partial<PluginRegistries>
  onPhase?: (phase: RuntimePreparationPhase) => void
}

export interface PrepareInstalledRuntimeOptions extends Omit<PrepareRuntimeOptions, 'registries' | 'onPhase'> {
  writeProfileManifest: typeof writeProfileManifest
}

export function prepareRuntime(options: PrepareRuntimeOptions): Promise<ReadyRuntimeStatus>
export function prepareInstalledRuntime(options: PrepareInstalledRuntimeOptions): Promise<ReadyRuntimeStatus>
export function withRuntimeUpdate<T>(profileDir: string, operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T>
