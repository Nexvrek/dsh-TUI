/**
 * What the channel submits, as pi `prompt` commands, and the bookkeeping that
 * ties pi's recorded user messages back to the channel's client ids.
 *
 * - Every placement goes out as `prompt` with a `streamingBehavior`: idle, pi
 *   starts a run; streaming, it queues the message as a steer (`steer`) or a
 *   follow-up (everything else). Sending the behavior unconditionally means
 *   no race with a run that started or settled while the command was on its
 *   way. `prompt` also runs extension commands and expands skills and prompt
 *   templates, as typing them into pi would. `now` aborts the running turn
 *   first (pi keeps its queue across an abort).
 * - pi's user messages carry no client id. Each accepted submission waits in
 *   FIFO order; a recorded user message claims the one with the same text,
 *   else the oldest (a template expansion changes the text). An extension
 *   command produces no message: pi ≥ 0.99 says so (`disposition: handled`);
 *   older ones are told apart by the command list.
 * - The channel shows every submission as a pending preview until a
 *   `pending.changed` claims or discards it, so every accepted submission is
 *   claimed: when pi records its message, or at once for an extension command
 *   (pi ran it; no message follows) and for this backend's own `/trust`. A
 *   submission pi queued (`disposition: queued`, or sent while a run was
 *   going) is also a pending item until then; clearing pi's queue discards
 *   those.
 */
import type { AgentEvent, PendingItem } from '../../../agent/events.js'
import type { AgentInput, CancelCause, CancelReceipt, SubmitPlacement } from '../../../agent/session.js'
import { piText } from '../text.js'
import { errorText, rec, str, type Rec } from '../narrow.js'
import { piImageContent } from '../translate/images.js'

interface Submission {
  readonly id: string
  /** What the user typed (the pending row). */
  readonly text: string
  /** What went to pi (what its recorded message says, unless expanded). */
  readonly sent: string
  readonly placement: 'steer' | 'followup'
}

export interface PiInputDeps {
  request(type: string, params?: Rec, options?: { readonly timeoutMs?: number }): Promise<unknown>
  emit(events: readonly AgentEvent[]): void
  /** A run is going (agent_start seen, agent_settled not yet). */
  running(): boolean
  /** Extension command names (no slash): such a prompt records no message. */
  extensionCommands(): ReadonlySet<string>
  /** Run a command of this backend's own (`/trust`); true when the text was
   *  one. Nothing goes to pi. */
  local(text: string): boolean
  /** Answer open dialogs `cancelled` before an abort (see dialogs.ts). */
  beforeAbort(): void
  /** Mark the next turn end as the user's interrupt. */
  noteCancel(): void
  debug(message: string): void
}

export interface PiInput {
  submit(input: AgentInput, placement: SubmitPlacement): Promise<{ readonly accepted: boolean; readonly reason?: string }>
  cancel(cause: CancelCause): Promise<CancelReceipt>
  /** The id a recorded user message carries (see the module comment). */
  claimUser(text: string): { readonly id: string; readonly before: readonly AgentEvent[] }
  /** Forget everything waiting (the child is gone). */
  reset(): AgentEvent[]
  /** Abort the running turn (dialogs answered first); false when pi refused. */
  abort(): Promise<boolean>
}

/** How long pi may take to accept a prompt (preflight may compact first). */
const PROMPT_TIMEOUT_MS = 10 * 60_000
/** How long an abort may take to reach idle before the turn closes here. */
export const ABORT_TIMEOUT_MS = 30_000

/** The model-facing text of an input: the channel's expanded blocks when it
 *  built them (`@` mentions, IDE selection), else the typed text. */
export function messageText(input: AgentInput): string {
  const blocks = input.blocks?.filter(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '') ?? []
  return blocks.length === 0 ? input.text : blocks.map(block => block.text!).join('\n\n')
}

/** The command name a `/name args` input invokes, else undefined. */
function commandName(text: string): string | undefined {
  return /^\/([^\s/]+)/u.exec(text)?.[1]
}

export function createPiInput(deps: PiInputDeps): PiInput {
  /** Accepted submissions whose user message pi has not recorded yet. */
  const awaiting: Submission[] = []
  /** The subset pi holds in its queue. */
  let queued: Submission[] = []
  let foreign = 0

  const pendingItems = (): PendingItem[] => queued.map(item => ({ id: item.id, text: item.text, placement: item.placement }))

  const abort = async (): Promise<boolean> => {
    deps.beforeAbort()
    deps.noteCancel()
    try {
      await deps.request('abort', {}, { timeoutMs: ABORT_TIMEOUT_MS })
      return true
    } catch (error) {
      deps.debug(`pi: abort failed (${errorText(error)})`)
      return false
    }
  }

  return {
    async submit(input, placement) {
      const text = messageText(input)
      let images: Awaited<ReturnType<typeof piImageContent>> = []
      try {
        images = await piImageContent(input.images ?? [])
      } catch (error) {
        return { accepted: false, reason: errorText(error) }
      }
      if (deps.local(input.text)) {
        deps.emit([{ type: 'pending.changed', items: pendingItems(), claimed: [input.clientMessageId] }])
        return { accepted: true }
      }
      if (placement === 'now' && deps.running()) await abort()
      const wasRunning = deps.running()
      const behavior = placement === 'steer' ? 'steer' : 'followUp'
      const name = commandName(text)
      const handledHere = name !== undefined && deps.extensionCommands().has(name)
      const submission: Submission = { id: input.clientMessageId, text: input.text, sent: text, placement: placement === 'steer' ? 'steer' : 'followup' }
      if (handledHere) {
        // pi answers an extension command only once its handler returns, and
        // a handler may be waiting on a dialog the user answers through this
        // very channel: accept now instead of holding the input pipeline.
        void deps.request('prompt', { message: text, ...(images.length === 0 ? {} : { images }), streamingBehavior: behavior }, { timeoutMs: 0 })
          .catch((error: unknown) => { deps.emit([{ type: 'notice', level: 'error', text: piText('pi-prompt-refused', { err: errorText(error) }) }]) })
        deps.emit([{ type: 'pending.changed', items: pendingItems(), claimed: [submission.id] }])
        return { accepted: true }
      }
      awaiting.push(submission)
      let answer: Rec | undefined
      try {
        answer = rec(await deps.request('prompt', { message: text, ...(images.length === 0 ? {} : { images }), streamingBehavior: behavior }, { timeoutMs: PROMPT_TIMEOUT_MS }))
      } catch (error) {
        const index = awaiting.indexOf(submission)
        if (index >= 0) awaiting.splice(index, 1)
        return { accepted: false, reason: piText('pi-prompt-refused', { err: errorText(error) }) }
      }
      const disposition = str(answer?.disposition)
      if (disposition === 'handled') {
        const index = awaiting.indexOf(submission)
        if (index >= 0) {
          awaiting.splice(index, 1)
          deps.emit([{ type: 'pending.changed', items: pendingItems(), claimed: [submission.id] }])
        }
        return { accepted: true }
      }
      if (awaiting.includes(submission) && (disposition === 'queued' || (disposition === undefined && wasRunning))) {
        queued = [...queued, submission]
        deps.emit([{ type: 'pending.changed', items: pendingItems() }])
      }
      return { accepted: true }
    },

    async cancel(cause) {
      const covered = queued.map(item => item.id)
      if (cause === 'interrupt') {
        // Drop pi's queue first: what the abort ends must not be followed by it.
        let cleared = false
        try {
          await deps.request('clear_queue')
          cleared = true
        } catch (error) {
          deps.debug(`pi: clear_queue failed (${errorText(error)})`)
        }
        if (cleared && queued.length > 0) {
          const discarded = queued.map(item => item.id)
          for (const item of queued) {
            const index = awaiting.indexOf(item)
            if (index >= 0) awaiting.splice(index, 1)
          }
          queued = []
          deps.emit([{ type: 'pending.changed', items: [], discarded }])
        }
        if (deps.running()) await abort()
        return cleared ? { stillQueued: [], outcome: 'confirmed' } : { stillQueued: covered, outcome: 'failed' }
      }
      const ok = deps.running() ? await abort() : true
      // pi keeps its queue across an abort: what was queued still runs.
      return { stillQueued: queued.map(item => item.id), outcome: ok ? 'confirmed' : 'failed' }
    },

    claimUser(text) {
      let index = awaiting.findIndex(item => item.sent === text)
      if (index < 0 && awaiting.length > 0) index = 0
      if (index < 0) return { id: `pi-user-${++foreign}`, before: [] }
      const claimed = awaiting.splice(index, 1)[0]!
      queued = queued.filter(item => item !== claimed)
      return { id: claimed.id, before: [{ type: 'pending.changed', items: pendingItems(), claimed: [claimed.id] }] }
    },

    reset() {
      const discarded = awaiting.map(item => item.id)
      awaiting.length = 0
      queued = []
      return discarded.length === 0 ? [] : [{ type: 'pending.changed', items: [], discarded }]
    },

    abort,
  }
}
