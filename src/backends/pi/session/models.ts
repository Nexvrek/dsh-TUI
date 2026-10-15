/**
 * pi's model catalog in the channel's vocabulary.
 *
 * pi serves models of many providers, and the same model id may come from
 * several of them, so the catalog routes by provider (`models.routes:
 * 'providers'`), as DSH's does: a model is the pair provider + model id, the
 * picker shows one tab per provider, and a switch names the provider.
 *
 * Thinking levels follow pi's own rule (`getSupportedThinkingLevels` in
 * `@earendil-works/pi-ai`): a model without reasoning has only `off`; otherwise
 * `off`…`max`, minus the levels its `thinkingLevelMap` maps to `null`, with
 * `xhigh`/`max` only when the map names them. A switch clamps the session's
 * level the same way pi does (the nearest supported level upward, else downward).
 */
import { rec, str, type Rec } from '../narrow.js'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The catalog row of `provider` + `modelId`; a bare id (no provider) takes
 *  `preferred` when it serves that id, else the first provider that does. */
export function findPiModelRow(rows: readonly Rec[], modelId: string, provider?: string, preferred?: string): Rec | undefined {
  const serving = rows.filter(row => str(row.id) === modelId)
  if (provider !== undefined && provider !== '') return serving.find(row => str(row.provider) === provider)
  return serving.find(row => str(row.provider) === preferred) ?? serving[0]
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
