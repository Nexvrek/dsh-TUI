/**
 * pi extension dialogs (`extension_ui_request`, pi's docs/rpc-extension-ui.md)
 * on the questionnaire panel.
 *
 * - `select` → one single-choice question over the offered options;
 *   `confirm` → yes / no; `input` → a free-text answer; `editor` → a free-text
 *   answer prefilled in the question body (an empty answer keeps the prefill).
 *   The answer goes back as `extension_ui_response` (`value` / `confirmed`),
 *   a dismissal as `cancelled: true`.
 * - `notify` → a notice. `setStatus`, `setWidget`, `setTitle` and
 *   `set_editor_text` drive pi's own terminal UI and have no surface here.
 * - pi settles a dialog itself when its `timeout` passes (or an extension's
 *   signal aborts it) and never says so; a late answer is dropped. So a
 *   dialog with a timeout is withdrawn here at that moment. Before an abort
 *   every open dialog is answered `cancelled`: an approval-style extension
 *   that ignores the abort signal would otherwise hold the abort forever.
 */
import type { AgentEvent, QuestionItemView } from '../../../agent/events.js'
import type { QuestionAnswers } from '../../../agent/capabilities.js'
import { piText } from '../text.js'
import { num, str, strings, type Rec } from '../narrow.js'

export interface PiDialogDeps {
  /** Write one `extension_ui_response` (throws when the child is gone). */
  respond(record: Rec): void
  emit(events: readonly AgentEvent[]): void
  debug(message: string): void
  /** Test seam for the timeout clock. */
  readonly setTimer?: (callback: () => void, ms: number) => { cancel(): void }
}

interface OpenDialog {
  readonly id: string
  readonly method: 'select' | 'confirm' | 'input' | 'editor'
  readonly options: readonly string[]
  readonly prefill?: string
  readonly yes: string
  readonly no: string
  readonly timer?: { cancel(): void }
}

export interface PiDialogs {
  /** Handle one `extension_ui_request`. */
  request(event: Rec): void
  respond(requestId: string, answers: QuestionAnswers): void
  cancel(requestId: string): void
  owns(requestId: string): boolean
  /** Answer every open dialog `cancelled` (abort, switch, dispose). */
  withdrawAll(): void
  readonly size: number
}

const PREFIX = 'pi-ui:'

const defaultTimer = (callback: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(callback, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function createPiDialogs(deps: PiDialogDeps): PiDialogs {
  const open = new Map<string, OpenDialog>()
  const setTimer = deps.setTimer ?? defaultTimer

  const send = (record: Rec): void => {
    try {
      deps.respond({ type: 'extension_ui_response', ...record })
    } catch (error) {
      deps.debug(`pi: dialog answer not delivered (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const settle = (requestId: string): OpenDialog | undefined => {
    const dialog = open.get(requestId)
    if (dialog === undefined) return undefined
    open.delete(requestId)
    dialog.timer?.cancel()
    deps.emit([{ type: 'question.settled', requestId }])
    return dialog
  }

  const ask = (id: string, method: OpenDialog['method'], question: QuestionItemView, extra: { readonly options?: readonly string[]; readonly prefill?: string; readonly timeout?: number }): void => {
    const requestId = `${PREFIX}${id}`
    if (open.has(requestId)) return
    const timeout = extra.timeout
    const timer = timeout !== undefined && timeout > 0
      ? setTimer(() => {
        if (settle(requestId) !== undefined) deps.emit([{ type: 'notice', level: 'info', key: `pi-dialog:${id}`, text: piText('pi-dialog-expired') }])
      }, timeout)
      : undefined
    open.set(requestId, {
      id, method, options: extra.options ?? [],
      ...(extra.prefill === undefined ? {} : { prefill: extra.prefill }),
      yes: piText('pi-dialog-yes'), no: piText('pi-dialog-no'),
      ...(timer === undefined ? {} : { timer }),
    })
    deps.emit([{ type: 'question.request', request: { requestId, questions: [question] } }])
  }

  return {
    request(event) {
      const id = str(event.id)
      const method = str(event.method)
      if (id === undefined || method === undefined) return
      const header = piText('pi-dialog-header')
      const timeout = num(event.timeout)
      switch (method) {
        case 'select': {
          const options = strings(event.options)
          if (options.length === 0) { send({ id, cancelled: true }); return }
          ask(id, 'select', { question: str(event.title) ?? header, header, options: options.map(label => ({ label })), hideCustomInput: true }, { options, ...(timeout === undefined ? {} : { timeout }) })
          return
        }
        case 'confirm': {
          const message = str(event.message)
          ask(id, 'confirm', {
            question: str(event.title) ?? header, header,
            ...(message === undefined || message === '' ? {} : { detail: message }),
            options: [{ label: piText('pi-dialog-yes') }, { label: piText('pi-dialog-no') }], hideCustomInput: true,
          }, timeout === undefined ? {} : { timeout })
          return
        }
        case 'input': {
          const placeholder = str(event.placeholder)
          ask(id, 'input', { question: str(event.title) ?? header, header, ...(placeholder === undefined || placeholder === '' ? {} : { detail: placeholder }), options: [] }, timeout === undefined ? {} : { timeout })
          return
        }
        case 'editor': {
          const prefill = str(event.prefill)
          ask(id, 'editor', {
            question: str(event.title) ?? header, header,
            ...(prefill === undefined || prefill === '' ? {} : { detail: piText('pi-dialog-prefill', { text: prefill }) }),
            options: [],
          }, prefill === undefined ? {} : { prefill })
          return
        }
        case 'notify': {
          const message = str(event.message) ?? ''
          if (message === '') return
          const kind = str(event.notifyType)
          deps.emit([{ type: 'notice', level: kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info', text: message }])
          return
        }
        default:
          deps.debug(`pi: extension UI ${method} has no surface here`)
          return
      }
    },
    respond(requestId, answers) {
      const dialog = settle(requestId)
      if (dialog === undefined) return
      const answer = answers.answers[0]
      const picked = answer?.selected[0]
      const custom = answer?.custom
      switch (dialog.method) {
        case 'select':
          if (picked !== undefined && dialog.options.includes(picked)) send({ id: dialog.id, value: picked })
          else send({ id: dialog.id, cancelled: true })
          return
        case 'confirm':
          if (picked === dialog.yes) send({ id: dialog.id, confirmed: true })
          else if (picked === dialog.no) send({ id: dialog.id, confirmed: false })
          else send({ id: dialog.id, cancelled: true })
          return
        case 'input':
          if (custom === undefined) send({ id: dialog.id, cancelled: true })
          else send({ id: dialog.id, value: custom })
          return
        case 'editor': {
          const value = custom !== undefined && custom !== '' ? custom : dialog.prefill
          if (value === undefined) send({ id: dialog.id, cancelled: true })
          else send({ id: dialog.id, value })
          return
        }
      }
    },
    cancel(requestId) {
      const dialog = settle(requestId)
      if (dialog !== undefined) send({ id: dialog.id, cancelled: true })
    },
    owns: requestId => open.has(requestId),
    withdrawAll() {
      for (const requestId of [...open.keys()]) {
        const dialog = settle(requestId)
        if (dialog !== undefined) send({ id: dialog.id, cancelled: true })
      }
    },
    get size() { return open.size },
  }
}
