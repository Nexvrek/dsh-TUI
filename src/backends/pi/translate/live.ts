/**
 * pi RPC events → Agent Domain events, live (pi's docs/json.md).
 *
 * The settled records go through the same mapping replay uses (`core.ts`):
 * a user message lands at `message_start` (its full content is there), an
 * assistant message settles at `message_end` (the authoritative message;
 * the `message_update` deltas before it only stream), a tool result settles
 * at its `toolResult` message. `agent_settled` closes the turn: retries,
 * compaction recovery and queued follow-ups may all come before it.
 *
 * Queue, dialog and status events are the session's (`session.ts`); this
 * module only names what they render as.
 */
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import { piText } from '../text.js'
import { num, rec, str, type Rec } from '../narrow.js'
import type { PiRpcEvent } from '../rpc/transport.js'
import {
  bashExecutionMessage, closeTurn, compactionSummary, customMessage, endReason, ensureAttempt, issueToolCall,
  settleAssistant, settleToolResult, userMessage, userText, type PiTranslatorContext,
} from './core.js'
import { resultText } from './presentation.js'

export interface PiLiveDeps {
  /** The id a recorded user message carries: the channel's client id of the
   *  submission it answers (matched by text, else the oldest awaiting one),
   *  or a synthesized id for a message nobody submitted here. `before` are
   *  events that must precede it (the queue snapshot that lost the item). */
  claimUser(text: string): { readonly id: string; readonly before: readonly AgentEvent[] }
}

export interface PiLiveTranslator {
  /** One RPC event's Agent events and how urgently they publish. */
  event(event: PiRpcEvent): { readonly events: readonly AgentEvent[]; readonly wake: NonNullable<AgentEventMeta['wake']> }
  /** Close the open turn here (the child died, a cancel went unanswered). */
  forceClose(reason: Parameters<typeof closeTurn>[2]): AgentEvent[]
}

/** How much of a rolling output window identifies where the last one ended. */
const OVERLAP_PROBE = 256

export function createLiveTranslator(ctx: PiTranslatorContext, deps: PiLiveDeps): PiLiveTranslator {
  /** The last output snapshot of each running tool (pi sends snapshots). */
  const outputs = new Map<string, string>()
  let compactions = 0

  const outputDelta = (callId: string, snapshot: string): string => {
    const previous = outputs.get(callId) ?? ''
    outputs.set(callId, snapshot)
    if (snapshot.startsWith(previous)) return snapshot.slice(previous.length)
    // A truncated tail window rolled forward: continue after the overlap.
    const probe = previous.slice(-OVERLAP_PROBE)
    const at = probe === '' ? -1 : snapshot.lastIndexOf(probe)
    return at >= 0 ? snapshot.slice(at + probe.length) : snapshot
  }

  const assistantDelta = (out: AgentEvent[], update: Rec, time: number): void => {
    const type = str(update.type)
    const attempt = ensureAttempt(ctx, out, time)
    const index = num(update.contentIndex) ?? 0
    switch (type) {
      case 'text_delta': {
        const delta = str(update.delta) ?? ''
        if (delta === '') return
        attempt.streamedText += delta
        out.push({ type: 'assistant.delta', attemptId: attempt.id, index, time, delta: { kind: 'text', text: delta } })
        return
      }
      case 'thinking_delta': {
        const delta = str(update.delta) ?? ''
        if (delta === '') return
        attempt.streamedReasoning += delta
        out.push({ type: 'assistant.delta', attemptId: attempt.id, index, time, delta: { kind: 'reasoning', text: delta } })
        return
      }
      case 'toolcall_start': {
        const callId = str(update.id)
        if (callId === undefined || callId === '') return
        attempt.toolBlocks.set(index, callId)
        const name = str(update.toolName)
        out.push({ type: 'assistant.delta', attemptId: attempt.id, index, time, delta: { kind: 'tool-args', callId, partialJson: '', ...(name === undefined ? {} : { name }) } })
        return
      }
      case 'toolcall_delta': {
        const callId = attempt.toolBlocks.get(index)
        const delta = str(update.delta) ?? ''
        if (callId === undefined || delta === '') return
        out.push({ type: 'assistant.delta', attemptId: attempt.id, index, time, delta: { kind: 'tool-args', callId, partialJson: delta } })
        return
      }
      default:
        return
    }
  }

  return {
    event(event) {
      const out: AgentEvent[] = []
      const time = ctx.now()
      switch (event.type) {
        case 'message_start': {
          const message = rec(event.message)
          if (message?.role === 'user') {
            const claim = deps.claimUser(userText(message.content))
            out.push(...claim.before)
            userMessage(ctx, out, message, num(message.timestamp) ?? time, { id: claim.id, anchor: claim.id })
          } else if (message?.role === 'assistant') {
            ensureAttempt(ctx, out, time, str(message.model))
          }
          return { events: out, wake: 'sync' }
        }
        case 'message_update': {
          const update = rec(event.assistantMessageEvent)
          if (update !== undefined) assistantDelta(out, update, time)
          return { events: out, wake: 'frame' }
        }
        case 'message_end': {
          const message = rec(event.message)
          switch (message?.role) {
            case 'assistant':
              settleAssistant(ctx, out, message, num(message.timestamp) ?? time)
              break
            case 'toolResult':
              outputs.delete(str(message.toolCallId) ?? '')
              settleToolResult(ctx, out, message, num(message.timestamp) ?? time)
              break
            case 'custom':
              if (message.display !== false) customMessage(ctx, out, message, num(message.timestamp) ?? time, `pi-custom-${ctx.seq + 1}`)
              break
            case 'bashExecution':
              if (message.excludeFromContext !== true) bashExecutionMessage(ctx, out, message, num(message.timestamp) ?? time, `pi-bash-${ctx.seq + 1}`)
              break
            default:
              break
          }
          return { events: out, wake: 'sync' }
        }
        case 'tool_execution_start': {
          // Normally issued when its assistant message settled; a call that
          // starts without one (an extension-driven call) still gets a card.
          const callId = str(event.toolCallId)
          const name = str(event.toolName)
          if (callId !== undefined && name !== undefined && !ctx.openTools.has(callId)) issueToolCall(ctx, out, { id: callId, name, args: event.args }, time)
          return { events: out, wake: 'sync' }
        }
        case 'tool_execution_update': {
          const callId = str(event.toolCallId)
          if (callId === undefined || !ctx.openTools.has(callId)) return { events: out, wake: 'none' }
          const delta = outputDelta(callId, resultText(rec(event.partialResult)?.content))
          if (delta !== '') out.push({ type: 'tool.output', callId, text: delta, time })
          return { events: out, wake: 'frame' }
        }
        case 'compaction_start': {
          out.push({ type: 'compaction.start', trigger: event.reason === 'manual' ? 'manual' : 'auto', cancellable: false, time })
          return { events: out, wake: 'sync' }
        }
        case 'compaction_end': {
          const result = rec(event.result)
          const summary = str(result?.summary)
          const pre = num(result?.tokensBefore)
          const post = num(result?.estimatedTokensAfter)
          const error = str(event.errorMessage)
          out.push({
            type: 'compaction.end',
            ok: result !== undefined,
            ...(pre === undefined ? {} : { preTokens: pre }),
            ...(post === undefined ? {} : { postTokens: post }),
            ...(result === undefined && event.aborted !== true && error !== undefined ? { error } : {}),
            time,
          })
          if (summary !== undefined && summary !== '') compactionSummary(ctx, out, summary, time, `pi-compaction-${++compactions}`)
          return { events: out, wake: 'sync' }
        }
        case 'auto_retry_start': {
          const attempt = num(event.attempt) ?? 1
          const max = num(event.maxAttempts) ?? attempt
          const seconds = Math.max(1, Math.round((num(event.delayMs) ?? 0) / 1000))
          out.push({ type: 'notice', level: 'warning', key: 'pi-retry', text: piText('pi-retry', { attempt, max, seconds, err: str(event.errorMessage) ?? '' }) })
          return { events: out, wake: 'sync' }
        }
        case 'auto_retry_end': {
          if (event.success === false) out.push({ type: 'notice', level: 'error', key: 'pi-retry', text: piText('pi-retry-failed', { err: str(event.finalError) ?? '' }) })
          return { events: out, wake: 'sync' }
        }
        case 'session_info_changed': {
          out.push({ type: 'session.title', title: str(event.name)?.trim() ?? '', source: 'user' })
          return { events: out, wake: 'sync' }
        }
        case 'thinking_level_changed': {
          const level = str(event.level)
          if (level !== undefined) out.push({ type: 'effort.changed', effort: level })
          return { events: out, wake: 'sync' }
        }
        case 'extension_error': {
          const where = str(event.extensionPath) ?? '?'
          out.push({ type: 'notice', level: 'warning', key: `pi-extension:${where}`, text: piText('pi-extension-error', { extension: where, event: str(event.event) ?? '?', err: str(event.error) ?? '' }) })
          return { events: out, wake: 'sync' }
        }
        case 'agent_settled': {
          if (ctx.turnOpen) closeTurn(ctx, out, endReason(ctx, event.aborted === true), time)
          ctx.cancelRequested = false
          outputs.clear()
          return { events: out, wake: 'sync' }
        }
        default:
          // agent_start / agent_end / turn_* carry nothing the settled records
          // do not; queue, dialog and status events are the session's.
          return { events: out, wake: 'none' }
      }
    },
    forceClose(reason) {
      const out: AgentEvent[] = []
      if (ctx.turnOpen || ctx.attempt !== undefined) closeTurn(ctx, out, reason, ctx.now())
      outputs.clear()
      return out
    },
  }
}
