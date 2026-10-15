/**
 * Narrowing helpers for pi's untyped RPC JSON and session files (the
 * counterpart of `codex/narrow.ts`): every value read at run time goes
 * through these.
 */

export type Rec = Readonly<Record<string, unknown>>

/** A plain object (not an array), else undefined. */
export const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined

export const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** A non-empty string, else undefined. */
export const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

/** A finite number, else undefined. */
export const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

export const arr = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** The string members of an array value. */
export const strings = (value: unknown): readonly string[] => arr(value).filter((item): item is string => typeof item === 'string')

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
