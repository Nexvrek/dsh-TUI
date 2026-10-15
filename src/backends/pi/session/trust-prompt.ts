/**
 * pi's project trust question (`../trust.ts`) on the questionnaire panel:
 * asked when a session opens on a project pi has no decision for — where
 * pi's own interface asks and RPC mode does not — and on `/trust`.
 *
 * - The choices are pi's: trust, trust the parent folder, trust for this
 *   session only, and the two refusals. A remembered choice goes to pi's
 *   trust.json, shared with pi's own interface; a session-only one lasts
 *   while this process runs.
 * - A choice that changes what the running child loaded restarts it on the
 *   same session (`session.ts`): pi settles trust only at startup.
 * - Dismissing the opening question leaves the project untrusted for this
 *   process, as dismissing pi's prompt does; dismissing `/trust` changes
 *   nothing.
 */
import type { AgentEvent } from '../../../agent/events.js'
import type { QuestionAnswers } from '../../../agent/capabilities.js'
import { piText } from '../text.js'
import { errorText } from '../narrow.js'
import { piTrustChoices, piTrustResources, setPiSessionTrust, writePiTrust, type PiTrustChoice } from '../trust.js'

export interface PiTrustPromptDeps {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  emit(events: readonly AgentEvent[]): void
  /** Whether the running child loaded the project's resources. */
  trusted(): boolean
  /** Restart the child so it loads (or drops) them. */
  restart(): void
}

export interface PiTrustPrompt {
  /** Open the question: `open` when the session opens, `command` on `/trust`. */
  ask(reason: 'open' | 'command'): void
  owns(requestId: string): boolean
  respond(requestId: string, answers: QuestionAnswers): Promise<void>
  cancel(requestId: string): void
  /** Close an open question unanswered (switch, dispose, a lost child). */
  withdraw(): void
}

type LabelledChoice = PiTrustChoice & { readonly label: string; readonly description: string }

const PREFIX = 'pi-trust:'

function labelled(choice: PiTrustChoice): LabelledChoice {
  switch (choice.id) {
    case 'trust': return { ...choice, label: piText('pi-trust-opt-trust'), description: piText('pi-trust-opt-remembered') }
    case 'trust-parent': return { ...choice, label: piText('pi-trust-opt-parent', { path: choice.parent ?? '' }), description: piText('pi-trust-opt-parent-desc') }
    case 'trust-session': return { ...choice, label: piText('pi-trust-opt-session'), description: piText('pi-trust-opt-session-desc') }
    case 'deny': return { ...choice, label: piText('pi-trust-opt-deny'), description: piText('pi-trust-opt-remembered') }
    case 'deny-session': return { ...choice, label: piText('pi-trust-opt-deny-session'), description: piText('pi-trust-opt-session-desc') }
  }
}

export function createPiTrustPrompt(deps: PiTrustPromptDeps): PiTrustPrompt {
  let open: { readonly requestId: string; readonly reason: 'open' | 'command'; readonly choices: readonly LabelledChoice[] } | undefined
  let asked = 0

  // Outcomes are toasts: the opening question is often answered on the
  // launchpad, where transcript rows do not show; the answered question
  // stays in the transcript as the record.
  const notice = (key: Parameters<typeof piText>[0], level: 'notice' | 'error' = 'notice', params: Record<string, string> = {}): void => {
    deps.emit([{ type: 'notice', level, key: 'pi-trust', text: piText(key, params) }])
  }

  const settle = (requestId: string): typeof open => {
    if (open === undefined || open.requestId !== requestId) return undefined
    const settled = open
    open = undefined
    deps.emit([{ type: 'question.settled', requestId }])
    return settled
  }

  /** The question dismissed: the opening one leaves the project untrusted
   *  for this process (as in pi), `/trust` changes nothing. */
  const dismissed = (reason: 'open' | 'command'): void => {
    if (reason !== 'open') return
    setPiSessionTrust(deps.cwd, false)
    notice('pi-trust-kept-untrusted')
  }

  return {
    ask(reason) {
      if (open !== undefined) return
      const resources = piTrustResources(deps.cwd, deps.env)
      if (resources.length === 0) {
        notice('pi-trust-not-needed')
        return
      }
      const choices = piTrustChoices(deps.cwd).map(labelled)
      const requestId = `${PREFIX}${++asked}`
      open = { requestId, reason, choices }
      const detail = [
        deps.cwd,
        piText('pi-trust-found', { resources: resources.join(', ') }),
        piText('pi-trust-means'),
        ...(reason === 'command' ? [piText(deps.trusted() ? 'pi-trust-now-trusted' : 'pi-trust-now-untrusted')] : []),
      ].join('\n\n')
      deps.emit([{
        type: 'question.request',
        request: {
          requestId,
          questions: [{
            question: piText('pi-trust-question'),
            header: piText('pi-trust-header'),
            detail,
            options: choices.map(choice => ({ label: choice.label, description: choice.description })),
            hideCustomInput: true,
          }],
        },
      }])
    },

    owns: requestId => open !== undefined && open.requestId === requestId,

    async respond(requestId, answers) {
      const settled = settle(requestId)
      if (settled === undefined) return
      const picked = answers.answers[0]?.selected[0]
      const choice = settled.choices.find(item => item.label === picked)
      if (choice === undefined) {
        dismissed(settled.reason)
        return
      }
      try {
        await writePiTrust(choice.updates, deps.env)
      } catch (error) {
        notice('pi-trust-write-failed', 'error', { err: errorText(error) })
        return
      }
      setPiSessionTrust(deps.cwd, choice.updates.length === 0 ? choice.trusted : undefined)
      if (choice.trusted !== deps.trusted()) deps.restart()
      else notice(choice.trusted ? 'pi-trust-kept-trusted' : 'pi-trust-kept-untrusted')
    },

    cancel(requestId) {
      const settled = settle(requestId)
      if (settled !== undefined) dismissed(settled.reason)
    },

    withdraw() {
      if (open !== undefined) settle(open.requestId)
    },
  }
}
