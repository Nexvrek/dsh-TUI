/**
 * pi's model catalog in the channel's vocabulary.
 *
 * The channel treats a backend as one provider whose model ids are unique
 * (`/model <id>` takes no provider segment), while pi serves models of many
 * providers whose ids may repeat across them. A model's id here is therefore
 * the key `provider/modelId` (split at the first `/`: provider names have
 * none, model ids may); the footer shows the bare model id
 * (`models.display()`).
 *
 * Thinking levels follow pi's own rule (`getSupportedThinkingLevels` in
 * `@earendil-works/pi-ai`): a model without reasoning has only `off`; otherwise
 * `off`…`max`, minus the levels its `thinkingLevelMap` maps to `null`, with
 * `xhigh`/`max` only when the map names them. A switch clamps the session's
 * level the same way pi does (the nearest supported level upward, else downward).
 */
import { rec, str, type Rec } from '../narrow.js'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The channel-facing id of a pi model. */
export function piModelKey(provider: string, modelId: string): string {
  return provider === '' ? modelId : `${provider}/${modelId}`
}

/** A model key back to pi's `provider` and `modelId` (no slash = bare id). */
export function splitPiModelKey(key: string): { readonly provider?: string; readonly modelId: string } {
  const slash = key.indexOf('/')
  return slash <= 0 ? { modelId: key } : { provider: key.slice(0, slash), modelId: key.slice(slash + 1) }
}

/** The thinking levels a model row supports, in pi's order. */
export function piThinkingLevels(row: Rec | undefined): string[] {
  if (row === undefined) return []
  if (row.reasoning !== true) return ['off']
  const map = rec(row.thinkingLevelMap)
  return LEVELS.filter(level => {
    const mapped = map?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** The level a session at `level` lands on after switching to `row`. */
export function clampPiThinkingLevel(row: Rec | undefined, level: string | undefined): string | undefined {
  const available = piThinkingLevels(row)
  if (level === undefined || available.length === 0) return available[0]
  if (available.includes(level)) return level
  const index = (LEVELS as readonly string[]).indexOf(level)
  if (index < 0) return available[0]
  for (let up = index; up < LEVELS.length; up++) if (available.includes(LEVELS[up]!)) return LEVELS[up]
  for (let down = index - 1; down >= 0; down--) if (available.includes(LEVELS[down]!)) return LEVELS[down]
  return available[0]
}

/** The key of one `get_available_models` row, else undefined. */
export function rowKey(row: Rec): string | undefined {
  const id = str(row.id)
  return id === undefined || id === '' ? undefined : piModelKey(str(row.provider) ?? '', id)
}
