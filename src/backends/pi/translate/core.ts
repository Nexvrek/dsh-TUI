/**
 * pi messages → Agent Domain events: the one mapping live events
 * (`live.ts`) and history replay (`replay.ts`) share.
 *
 * Turns, steps and attempts:
 *  - pi's own "turn" is one assistant response plus the tool calls it made;
 *    that is a *step* here. A turn here is what a user prompt sets off: it
 *    opens with the first message of a run and closes when pi settles
 *    (`agent_settled` live; the next prompt, or the end, in replay). Retries
 *    and compaction recovery stay inside it.
 *  - A user message joins the open turn when the turn's last record is a
 *    tool call or result (a steering message pi injected between tool calls);
 *    after a final assistant reply it starts a new turn (a follow-up).
 *  - One assistant message is one attempt in its own step
 *    (`t<turn>s<step>`): streamed deltas live, the settled message (the
 *    canonical record) in both paths, then its tool calls (`tool.call` with
 *    the final arguments), whose results join the same step.
 *  - A failed reply with nothing to show (provider error, often retried) is
 *    abandoned rather than settled as an empty bubble.
 *
 * Identity: replayed user messages use the session entry id as `id` and
 * `anchor` (pi's fork anchor); live ones carry the channel's client id.
 */
import type { AgentEvent, AgentEventOf, ContentBlockView, TurnEndReason, UsageDelta } from '../../../agent/events.js'
import { piText } from '../text.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import { contentImages } from './images.js'
import { presentPiToolCall, presentPiToolResult, resultText } from './presentation.js'

/** The attempt (one assistant message) being assembled live. */
export interface OpenAttempt {
  readonly id: string
  readonly step: number
  /** Text and thinking streamed so far (what an interrupted reply keeps). */
  streamedText: string
  streamedReasoning: string
  /** contentIndex → tool call id of a streaming tool-call block. */
  readonly toolBlocks: Map<number, string>
}

/** What the open turn recorded last (decides where a user message lands). */
export type TurnTail = 'none' | 'user' | 'assistant-final' | 'assistant-tools' | 'tool-result' | 'other'

export interface PiContextOptions {
  readonly cwd: string
  readonly now?: () => number
  readonly debug?: (message: string) => void
  readonly model?: string
  readonly contextWindow?: number
}

/** The translator state live and replay share (and hand over). */
export interface PiTranslatorContext {
  readonly cwd: string
  readonly debug: (message: string) => void
  now(): number
  nextSeq(): number
  readonly seq: number
  model: string
  contextWindow: number | undefined
  turn: number
  turnOpen: boolean
  step: number
  stepOpen: boolean
  attempt: OpenAttempt | undefined
  tail: TurnTail
  /** The last assistant stop reason and error of the open turn. */
  lastStop: string | undefined
  lastError: string | undefined
  /** Tool calls issued and not yet settled: id → name and arguments. */
  readonly openTools: Map<string, { readonly name: string; readonly args: unknown }>
  /** Usage of the open turn (its `turn.end`). */
  turnUsage: UsageDelta | undefined
  /** A cancel this session asked for is running (an abort reads as interrupted). */
  cancelRequested: boolean
  /** Synthesized ids for user messages nobody submitted through the channel. */
  foreignUsers: number
  /** Every user row in order (anchor and text): how a rewind or fork maps a
   *  live row, which carries the channel's client id, to pi's entry. */
  readonly userRows: { readonly anchor: string; readonly text: string }[]
}

export function createPiContext(options: PiContextOptions): PiTranslatorContext {
  let seq = 0
  const clock = options.now ?? Date.now
  return {
    cwd: options.cwd,
    debug: options.debug ?? (() => undefined),
    now: () => clock(),
    nextSeq: () => ++seq,
    get seq() { return seq },
    model: options.model ?? '',
    contextWindow: options.contextWindow,
    turn: 0,
    turnOpen: false,
    step: 0,
    stepOpen: false,
    attempt: undefined,
    tail: 'none',
    lastStop: undefined,
    lastError: undefined,
    openTools: new Map(),
    turnUsage: undefined,
    cancelRequested: false,
    foreignUsers: 0,
    userRows: [],
  }
}

/** A message timestamp (epoch ms), else the clock. */
export function messageTime(ctx: PiTranslatorContext, message: Rec | undefined, fallback?: unknown): number {
  const own = num(message?.timestamp)
  if (own !== undefined) return own
  const iso = str(fallback)
  const parsed = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : ctx.now()
}

export function openTurn(ctx: PiTranslatorContext, out: AgentEvent[], origin: AgentEventOf<'turn.start'>['origin'], time: number, userMessageId?: string): void {
  if (ctx.turnOpen) return
  ctx.turnOpen = true
  ctx.turn += 1
  ctx.step = 0
  ctx.stepOpen = false
  ctx.tail = 'none'
  ctx.lastStop = undefined
  ctx.lastError = undefined
  ctx.turnUsage = undefined
  out.push({ type: 'turn.start', turn: ctx.turn, origin, time, ...(userMessageId === undefined ? {} : { userMessageId }) })
}

export function closeStep(ctx: PiTranslatorContext, out: AgentEvent[]): void {
  if (!ctx.stepOpen) return
  ctx.stepOpen = false
  out.push({ type: 'step.end', turn: ctx.turn, step: ctx.step })
}

/** A step for records no assistant message opened. */
export function ensureStep(ctx: PiTranslatorContext, out: AgentEvent[]): void {
  if (ctx.stepOpen) return
  ctx.step += 1
  ctx.stepOpen = true
  out.push({ type: 'step.start', turn: ctx.turn, step: ctx.step })
}

/** The open attempt, or a new one in a new step. */
export function ensureAttempt(ctx: PiTranslatorContext, out: AgentEvent[], time: number, model?: string): OpenAttempt {
  if (ctx.attempt !== undefined) return ctx.attempt
  if (!ctx.turnOpen) openTurn(ctx, out, 'system', time)
  closeStep(ctx, out)
  ctx.step += 1
  ctx.stepOpen = true
  out.push({ type: 'step.start', turn: ctx.turn, step: ctx.step })
  const id = `t${ctx.turn}s${ctx.step}`
  const name = model ?? ctx.model
  out.push({ type: 'assistant.attempt.start', attemptId: id, turn: ctx.turn, step: ctx.step, ...(name === '' ? {} : { model: name }), firstTokenTime: time })
  ctx.attempt = { id, step: ctx.step, streamedText: '', streamedReasoning: '', toolBlocks: new Map() }
  return ctx.attempt
}

/** pi usage → the neutral usage delta (unknown fields stay absent). */
export function usageOf(value: unknown): UsageDelta | undefined {
  const usage = rec(value)
  if (usage === undefined) return undefined
  const input = num(usage.input)
  const output = num(usage.output)
  const cacheRead = num(usage.cacheRead)
  const cacheWrite = num(usage.cacheWrite)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  }
}

function addUsage(total: UsageDelta | undefined, next: UsageDelta): UsageDelta {
  const sum = (a: number | undefined, b: number | undefined): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  const input = sum(total?.input, next.input)
  const output = sum(total?.output, next.output)
  const cacheRead = sum(total?.cacheRead, next.cacheRead)
  const cacheWrite = sum(total?.cacheWrite, next.cacheWrite)
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  }
}

/** The canonical blocks of an assistant message (thinking → reasoning). */
function assistantBlocks(content: unknown): ContentBlockView[] {
  const blocks: ContentBlockView[] = []
  for (const raw of arr(content)) {
    const block = rec(raw)
    if (block?.type === 'text') {
      const value = str(block.text) ?? ''
      if (value !== '') blocks.push({ type: 'text', text: value })
    } else if (block?.type === 'thinking') {
      const value = str(block.thinking) ?? ''
      if (value !== '') blocks.push({ type: 'reasoning', text: value })
    }
  }
  return blocks
}

/** The tool calls of an assistant message, in content order. */
function toolCallsOf(content: unknown): { readonly id: string; readonly name: string; readonly args: unknown }[] {
  return arr(content).flatMap(raw => {
    const block = rec(raw)
    const id = str(block?.id)
    const name = str(block?.name)
    return block?.type === 'toolCall' && id !== undefined && id !== '' && name !== undefined ? [{ id, name, args: block.arguments }] : []
  })
}

/** Issue one tool call (no-op when it is already open). */
export function issueToolCall(ctx: PiTranslatorContext, out: AgentEvent[], call: { readonly id: string; readonly name: string; readonly args: unknown }, time: number): void {
  if (ctx.openTools.has(call.id)) return
  ensureStep(ctx, out)
  ctx.openTools.set(call.id, { name: call.name, args: call.args })
  let argsJson = '{}'
  try { argsJson = JSON.stringify(call.args ?? {}) } catch { argsJson = '{}' }
  const presentation = presentPiToolCall(call.name, call.args, ctx.cwd)
  out.push({ type: 'tool.call', seq: ctx.nextSeq(), turn: ctx.turn, step: ctx.step, callId: call.id, name: call.name, argsJson, ...(presentation === undefined ? {} : { presentation }), time })
}

/**
 * Settle one assistant message: the canonical message (or an abandoned
 * attempt when a failure left nothing to show), its usage, then its tool
 * calls. The attempt is opened first when nothing streamed (replay).
 */
export function settleAssistant(ctx: PiTranslatorContext, out: AgentEvent[], message: Rec, time: number): void {
  const model = str(message.model)
  if (model !== undefined && model !== '') ctx.model = model
  const attempt = ensureAttempt(ctx, out, time, model)
  ctx.attempt = undefined
  const stop = str(message.stopReason)
  const errorMessage = str(message.errorMessage)
  let blocks = assistantBlocks(message.content)
  // A reply cut short may never have produced its final content blocks.
  if (blocks.length === 0 && stop === 'aborted') {
    if (attempt.streamedReasoning !== '') blocks.push({ type: 'reasoning', text: attempt.streamedReasoning })
    if (attempt.streamedText !== '') blocks.push({ type: 'text', text: attempt.streamedText })
  }
  const calls = toolCallsOf(message.content)
  const usage = usageOf(message.usage)
  ctx.lastStop = stop
  ctx.lastError = stop === 'error' ? errorMessage ?? '' : undefined
  if (blocks.length === 0 && calls.length === 0 && (stop === 'error' || stop === 'aborted')) {
    out.push({ type: 'assistant.attempt.end', attemptId: attempt.id, outcome: stop === 'aborted' ? 'aborted' : 'abandoned' })
  } else {
    out.push({
      type: 'assistant.message',
      seq: ctx.nextSeq(),
      anchor: attempt.id,
      turn: ctx.turn,
      step: attempt.step,
      attemptId: attempt.id,
      time,
      ...(ctx.model === '' ? {} : { model: ctx.model }),
      blocks,
      ...(usage === undefined ? {} : { usage }),
      ...(stop === 'aborted' ? { interrupted: true as const } : {}),
      canonical: true,
    })
    out.push({ type: 'assistant.attempt.end', attemptId: attempt.id, outcome: 'committed' })
  }
  if (usage !== undefined) {
    if (ctx.turnOpen) ctx.turnUsage = addUsage(ctx.turnUsage, usage)
    out.push({ type: 'usage', seq: ctx.nextSeq(), turn: ctx.turn, step: attempt.step, usage, time, ...(ctx.model === '' ? {} : { model: ctx.model }) })
    const total = num(rec(message.usage)?.totalTokens) ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    if (total > 0) out.push({ type: 'context.usage', used: total, ...(ctx.contextWindow === undefined ? {} : { max: ctx.contextWindow }) })
  }
  if (stop === 'error' && errorMessage !== undefined && errorMessage !== '' && blocks.length === 0) {
    out.push({ type: 'notice', level: 'warning', key: 'pi-reply-failed', text: piText('pi-reply-failed', { err: errorMessage }) })
  }
  for (const call of calls) issueToolCall(ctx, out, call, time)
  ctx.tail = calls.length > 0 ? 'assistant-tools' : 'assistant-final'
}

/** Settle one tool result (its call is issued first when it never was). */
export function settleToolResult(ctx: PiTranslatorContext, out: AgentEvent[], message: Rec, time: number): void {
  const callId = str(message.toolCallId)
  if (callId === undefined || callId === '') return
  const name = str(message.toolName) ?? 'tool'
  if (!ctx.turnOpen) openTurn(ctx, out, 'system', time)
  const open = ctx.openTools.get(callId)
  if (open === undefined) issueToolCall(ctx, out, { id: callId, name, args: {} }, time)
  const args = open?.args ?? {}
  ctx.openTools.delete(callId)
  ensureStep(ctx, out)
  const isError = message.isError === true
  const text = resultText(message.content)
  const content: ContentBlockView[] = arr(message.content).flatMap(raw => {
    const block = rec(raw)
    return block?.type === 'text' ? [{ type: 'text', text: str(block.text) ?? '' }] : block?.type === 'image' ? [{ type: 'image' }] : []
  })
  const images = contentImages(message.content, callId)
  const presentation = presentPiToolResult(name, args, { isError, text, details: message.details }, ctx.cwd)
  out.push({
    type: 'tool.result',
    seq: ctx.nextSeq(),
    turn: ctx.turn,
    step: ctx.step,
    callId,
    isError,
    time,
    content,
    text,
    ...(isError ? { errorText: text } : {}),
    ...(images.length === 0 ? {} : { images }),
    ...(message.details === undefined ? {} : { structured: message.details }),
    ...(presentation === undefined ? {} : { presentation }),
  })
  ctx.tail = 'tool-result'
}

/** The text of a user/custom message's content (a string or text blocks). */
export function userText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content).map(rec).filter(block => block?.type === 'text').map(block => str(block!.text) ?? '').join('\n')
}

/** Close the open turn when its run is over (it ended on a final reply): what
 *  comes next — a prompt, a compaction between runs — is not part of it. */
export function closeFinishedTurn(ctx: PiTranslatorContext, out: AgentEvent[], time: number): void {
  if (ctx.turnOpen && (ctx.tail === 'assistant-final' || ctx.tail === 'other')) closeTurn(ctx, out, endReason(ctx), time)
}

/** Where a user message lands: a steering message joins the running turn,
 *  anything else after a final reply opens the next one. */
export function placeUserMessage(ctx: PiTranslatorContext, out: AgentEvent[], time: number, userMessageId: string, origin: AgentEventOf<'turn.start'>['origin'] = 'user'): void {
  closeFinishedTurn(ctx, out, time)
  if (!ctx.turnOpen) openTurn(ctx, out, origin, time, userMessageId)
}

/** One user message (`id` = the channel's client id live, the entry id in replay). */
export function userMessage(ctx: PiTranslatorContext, out: AgentEvent[], message: Rec, time: number, ids: { readonly id: string; readonly anchor: string }): void {
  placeUserMessage(ctx, out, time, ids.id)
  const text = userText(message.content)
  const images = contentImages(message.content, ids.anchor)
  const blocks: ContentBlockView[] = typeof message.content === 'string'
    ? [{ type: 'text', text }]
    : arr(message.content).flatMap(raw => {
      const block = rec(raw)
      return block?.type === 'text' ? [{ type: 'text', text: str(block.text) ?? '' }] : block?.type === 'image' ? [{ type: 'image' }] : []
    })
  out.push({ type: 'user.message', id: ids.id, anchor: ids.anchor, seq: ctx.nextSeq(), turn: ctx.turn, time, source: 'user', text, blocks, ...(images.length === 0 ? {} : { images }) })
  ctx.userRows.push({ anchor: ids.anchor, text })
  ctx.tail = 'user'
}

/** An extension's context message (`role: 'custom'`): model input, never a bubble. */
export function customMessage(ctx: PiTranslatorContext, out: AgentEvent[], message: Rec, time: number, id: string): void {
  const text = userText(message.content)
  const label = str(message.customType)
  out.push({ type: 'user.message', id, anchor: id, seq: ctx.nextSeq(), ...(ctx.turnOpen ? { turn: ctx.turn } : {}), time, source: 'injected', text, blocks: [{ type: 'text', text }], ...(label === undefined ? {} : { label }) })
}

/** A direct shell command pi recorded (`role: 'bashExecution'`, from pi's own `!cmd`). */
export function bashExecutionMessage(ctx: PiTranslatorContext, out: AgentEvent[], message: Rec, time: number, id: string): void {
  const command = str(message.command) ?? ''
  const output = str(message.output) ?? ''
  const code = num(message.exitCode)
  const text = `$ ${command}${output === '' ? '' : `\n${output}`}${code === undefined || code === 0 ? '' : `\n${piText('pi-exit-code', { code })}`}`
  out.push({ type: 'user.message', id, anchor: id, seq: ctx.nextSeq(), ...(ctx.turnOpen ? { turn: ctx.turn } : {}), time, source: 'command-output', text, blocks: [{ type: 'text', text }] })
}

/** A compaction summary checkpoint (renders as the folded summary row). */
export function compactionSummary(ctx: PiTranslatorContext, out: AgentEvent[], summary: string, time: number, id: string): void {
  out.push({ type: 'user.message', id, anchor: id, seq: ctx.nextSeq(), ...(ctx.turnOpen ? { turn: ctx.turn } : {}), time, source: 'compaction', text: summary, blocks: [{ type: 'text', text: summary }] })
}

/** Why the open turn ends, from what it recorded and whether it was aborted. */
export function endReason(ctx: PiTranslatorContext, aborted = false): TurnEndReason {
  if (aborted || ctx.lastStop === 'aborted') return ctx.cancelRequested ? { kind: 'interrupted' } : { kind: 'aborted' }
  if (ctx.lastStop === 'error') return { kind: 'error', message: ctx.lastError ?? '' }
  if (ctx.lastStop === 'length') return { kind: 'other', label: 'max-tokens' }
  return { kind: 'completed' }
}

/**
 * Close the open turn: settle a still-open attempt with what streamed, end
 * the tools that never settled, close the step, `turn.end`. A turn that
 * recorded nothing opens first (a run that failed at once).
 */
export function closeTurn(ctx: PiTranslatorContext, out: AgentEvent[], reason: TurnEndReason, time: number): void {
  if (!ctx.turnOpen) openTurn(ctx, out, 'system', time)
  const interrupted = reason.kind === 'interrupted' || reason.kind === 'aborted'
  const open = ctx.attempt
  if (open !== undefined) {
    ctx.attempt = undefined
    const blocks: ContentBlockView[] = []
    if (open.streamedReasoning !== '') blocks.push({ type: 'reasoning', text: open.streamedReasoning })
    if (open.streamedText !== '') blocks.push({ type: 'text', text: open.streamedText })
    if (blocks.length === 0) {
      out.push({ type: 'assistant.attempt.end', attemptId: open.id, outcome: interrupted ? 'aborted' : 'abandoned' })
    } else {
      out.push({ type: 'assistant.message', seq: ctx.nextSeq(), anchor: open.id, turn: ctx.turn, step: open.step, attemptId: open.id, time, ...(ctx.model === '' ? {} : { model: ctx.model }), blocks, ...(interrupted ? { interrupted: true as const } : {}), canonical: true })
      out.push({ type: 'assistant.attempt.end', attemptId: open.id, outcome: 'committed' })
    }
  }
  for (const [callId] of ctx.openTools) {
    const errorText = interrupted ? piText('pi-interrupted') : piText('pi-tool-unfinished')
    out.push({ type: 'tool.result', seq: ctx.nextSeq(), turn: ctx.turn, step: ctx.step, callId, isError: true, time, content: [], text: '', errorText })
  }
  ctx.openTools.clear()
  closeStep(ctx, out)
  ctx.turnOpen = false
  out.push({ type: 'turn.end', turn: ctx.turn, reason, time, ...(ctx.turnUsage === undefined ? {} : { usage: ctx.turnUsage }) })
  ctx.turnUsage = undefined
  ctx.tail = 'none'
  ctx.cancelRequested = false
}
