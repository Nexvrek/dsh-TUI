/**
 * pi session entries → the replay seed (`AgentSession.history()`).
 *
 * The source is the session file's own entries (`get_entries`), not
 * `get_messages`: the latter is the model's context, which after a
 * compaction holds only the summary and the kept tail. The active branch is
 * the path from the leaf (`leafId`) up through `parentId` links; entries of
 * abandoned branches are not part of the conversation shown.
 *
 * Every entry of the path replays, so history a compaction folded away stays
 * visible above the summary checkpoint. `context_edit`, `usage`, `custom` and
 * `label` entries change nothing on screen; system messages (the prompt and
 * tool loadout) are not transcript rows.
 */
import type { AgentEvent } from '../../../agent/events.js'
import { piText } from '../text.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import {
  bashExecutionMessage, closeFinishedTurn, closeTurn, compactionSummary, customMessage, endReason, messageTime,
  settleAssistant, settleToolResult, userMessage, type PiTranslatorContext,
} from './core.js'

/** The entries on the path from the root to `leafId`, oldest first. */
export function activeBranch(entries: readonly unknown[], leafId: string | null | undefined): Rec[] {
  const byId = new Map<string, Rec>()
  const ordered: Rec[] = []
  for (const raw of entries) {
    const entry = rec(raw)
    const id = str(entry?.id)
    if (entry === undefined || id === undefined || entry.type === 'session') continue
    byId.set(id, entry)
    ordered.push(entry)
  }
  const leaf = leafId === null ? undefined : leafId ?? str(ordered.at(-1)?.id)
  if (leaf === undefined) return []
  const path: Rec[] = []
  const seen = new Set<string>()
  let cursor = byId.get(leaf)
  while (cursor !== undefined) {
    const id = str(cursor.id)!
    if (seen.has(id)) break
    seen.add(id)
    path.push(cursor)
    const parent = str(cursor.parentId)
    cursor = parent === undefined ? undefined : byId.get(parent)
  }
  return path.reverse()
}

/** One entry's events (the shared message mapping for `message` entries). */
export function entryEvents(ctx: PiTranslatorContext, entry: Rec, out: AgentEvent[]): void {
  const id = str(entry.id) ?? ''
  switch (entry.type) {
    case 'message': {
      const message = rec(entry.message)
      if (message === undefined) return
      const time = messageTime(ctx, message, entry.timestamp)
      switch (message.role) {
        case 'user':
          userMessage(ctx, out, message, time, { id, anchor: id })
          return
        case 'assistant':
          settleAssistant(ctx, out, message, time)
          return
        case 'toolResult':
          settleToolResult(ctx, out, message, time)
          return
        case 'custom':
          if (message.display !== false) customMessage(ctx, out, message, time, id)
          return
        case 'bashExecution':
          if (message.excludeFromContext !== true) bashExecutionMessage(ctx, out, message, time, id)
          return
        default:
          return
      }
    }
    case 'custom_message': {
      if (entry.display === false) return
      customMessage(ctx, out, entry, messageTime(ctx, undefined, entry.timestamp), id)
      return
    }
    case 'compaction': {
      // Live, the run that preceded a compaction settled before it began.
      const time = messageTime(ctx, undefined, entry.timestamp)
      closeFinishedTurn(ctx, out, time)
      compactionSummary(ctx, out, str(entry.summary) ?? '', time, id)
      return
    }
    case 'branch_summary': {
      const summary = str(entry.summary) ?? ''
      if (summary !== '') out.push({ type: 'notice', level: 'info', key: `pi-branch:${id}`, text: piText('pi-branch-summary', { summary }) })
      return
    }
    case 'model_change': {
      const model = str(entry.modelId)
      if (model === undefined || model === '') return
      const provider = str(entry.provider)
      ctx.model = model
      // The channel knows pi's models by `provider/modelId` (session/models.ts).
      out.push({ type: 'model.changed', model: provider === undefined || provider === '' ? model : `${provider}/${model}`, ...(provider === undefined ? {} : { provider }), source: 'resume' })
      return
    }
    case 'thinking_level_change': {
      const level = str(entry.thinkingLevel)
      if (level !== undefined) out.push({ type: 'effort.changed', effort: level })
      return
    }
    case 'session_info': {
      out.push({ type: 'session.title', title: str(entry.name)?.trim() ?? '', source: 'user' })
      return
    }
    default:
      return
  }
}

/** The replay of a session's active branch. A turn still open at the end is
 *  closed unless pi reports the session as streaming right now. */
export function replayEntries(ctx: PiTranslatorContext, entries: readonly unknown[], leafId: string | null | undefined, options: { readonly streaming?: boolean } = {}): AgentEvent[] {
  const out: AgentEvent[] = []
  let last: number | undefined
  for (const entry of activeBranch(arr(entries), leafId)) {
    entryEvents(ctx, entry, out)
    last = messageTime(ctx, rec(entry.message), entry.timestamp)
  }
  if (ctx.turnOpen && options.streaming !== true) closeTurn(ctx, out, endReason(ctx), last ?? ctx.now())
  return out
}
