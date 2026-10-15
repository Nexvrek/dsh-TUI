/**
 * One pi session as an `AgentSession`: a `pi --mode rpc` child of its own
 * (`rpc/transport.ts`), its events through the live translator to the
 * channel, input as `prompt` commands, extension dialogs on the
 * questionnaire panel.
 *
 * - Open: `get_state` is the readiness probe (pi has no ready event). A
 *   resumed session replays its active branch from `get_entries` before
 *   anything live; the live translator continues the replay's numbering.
 *   Events produced before the channel subscribed are kept and delivered on
 *   subscribe.
 * - Status: running from `agent_start` until `agent_settled`; an open
 *   extension dialog reads as `requires-action`.
 * - State pi does not announce (a model switch, a clamped thinking level) is
 *   read back with `get_state` after the command that changed it.
 * - The child dying is final for the session: the open turn closes as an
 *   error, dialogs and the queue are dropped, and input is refused.
 * - Project trust (`trust-prompt.ts`): pi settles it once, at startup, so a
 *   choice that changes what the child loaded restarts the child on the same
 *   session — after the running turn, if one is going. Commands sent
 *   meanwhile wait for the new child.
 * - Dispose: withdraw dialogs, abort a running turn, close the child.
 *   Idempotent.
 */
import { existsSync } from 'node:fs'
import type { AgentEvent, AgentEventMeta, CommandInfo } from '../../../agent/events.js'
import type { BackendLocale, OpenTarget } from '../../../agent/backend.js'
import type { ModelOption, ModelRef } from '../../../agent/capabilities.js'
import type { AgentSession, AgentSessionStatus, CancelCause } from '../../../agent/session.js'
import { installPiLocale, piText } from '../text.js'
import { PI_BACKEND_ID, piVersionDrift, VALIDATED_PI_VERSIONS } from '../contract.js'
import { arr, errorText, num, rec, str, strings, type Rec } from '../narrow.js'
import type { PiExecutable } from '../rpc/binary.js'
import type { PiExitInfo, PiRpcEvent, PiRpcLink } from '../rpc/transport.js'
import type { PiPrefs } from '../prefs.js'
import { piChildTrusted, piTrustUnsettled } from '../trust.js'
import { createPiContext } from '../translate/core.js'
import { PI_IMAGE_LIMITS } from '../translate/images.js'
import { createLiveTranslator } from '../translate/live.js'
import { replayEntries } from '../translate/replay.js'
import { resolveUserEntry, writePiBranch, type PiBranchSource } from './branch.js'
import { createPiDialogs } from './dialogs.js'
import { createPiInput } from './input.js'
import { clampPiThinkingLevel, findPiModelRow, piThinkingLevels } from './models.js'
import { createPiTrustPrompt } from './trust-prompt.js'

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void

export interface PiSessionDeps {
  readonly link: PiRpcLink
  /** A new child on this session (`--session <file>`, or `--session-id` for
   *  one pi has not saved yet), started with the trust decided by then. */
  readonly respawn: (target: { readonly sessionId: string; readonly sessionFile?: string }) => PiRpcLink
  readonly executable: PiExecutable
  readonly target: OpenTarget
  readonly cwd: string
  /** The child's environment (pi's agent directory: the trust store). */
  readonly env: NodeJS.ProcessEnv
  readonly prefs: PiPrefs
  readonly host: { readonly debug: (message: string) => void; readonly locale?: () => BackendLocale }
  /** pi's agent directory (`/doctor`). */
  readonly agentDir?: string
  readonly now?: () => number
  /** Bound for the readiness probe and the history read. */
  readonly startTimeoutMs?: number
}

/** The model facts of `get_state` / `set_model` answers. */
interface ModelState {
  provider: string
  id: string
  name: string
  contextWindow: number | undefined
}

function modelOf(value: unknown): ModelState | undefined {
  const model = rec(value)
  const id = str(model?.id)
  if (model === undefined || id === undefined || id === '') return undefined
  const provider = str(model.provider) ?? ''
  return { provider, id, name: str(model.name) ?? id, contextWindow: num(model.contextWindow) }
}

/** Open the child's session and wrap it. Throws a user-facing sentence when
 *  pi does not come up; the child is closed then. */
export async function openPiSession(deps: PiSessionDeps): Promise<AgentSession> {
  if (deps.host.locale !== undefined) installPiLocale(deps.host.locale)
  let link = deps.link
  const debug = deps.host.debug
  const startTimeoutMs = deps.startTimeoutMs ?? 90_000
  // What the child was started with, and whether pi's own interface would
  // have asked about this project.
  let childTrusted = piChildTrusted(deps.cwd, deps.env)
  const askTrust = piTrustUnsettled(deps.cwd, deps.env)

  // Events can arrive while the probe and the history read are in flight
  // (an extension's notify on session start): hold them for the replay.
  const held: PiRpcEvent[] = []
  let handle: ((event: PiRpcEvent) => void) | undefined
  let offEvent = link.onEvent(event => { if (handle === undefined) held.push(event); else handle(event) })

  let state: Rec
  let replay: readonly AgentEvent[] = []
  let levels: readonly string[] = []
  const ctx = createPiContext({ cwd: deps.cwd, debug, ...(deps.now === undefined ? {} : { now: deps.now }) })
  try {
    state = rec(await link.request('get_state', {}, { timeoutMs: startTimeoutMs })) ?? {}
    if (str(state.sessionId) === undefined) throw new Error('get_state named no session')
    const model = modelOf(state.model)
    ctx.model = model?.id ?? ''
    ctx.contextWindow = model?.contextWindow
    if (deps.target.kind === 'resume') {
      const answer = rec(await link.request('get_entries', {}, { timeoutMs: startTimeoutMs }))
      replay = replayEntries(ctx, arr(answer?.entries), answer?.leafId === null ? null : str(answer?.leafId), { streaming: state.isStreaming === true })
    }
    try {
      levels = strings(rec(await link.request('get_available_thinking_levels'))?.levels)
    } catch (error) {
      debug(`pi: thinking levels unavailable (${errorText(error)})`)
    }
  } catch (error) {
    offEvent()
    await link.close({ graceMs: 500 })
    throw new Error(piText('pi-start-failed', { err: errorText(error) }), { cause: error })
  }

  const sessionId = str(state.sessionId)!
  let sessionFile = str(state.sessionFile)
  let model = modelOf(state.model)
  let thinkingLevel = str(state.thinkingLevel)
  let running = state.isStreaming === true
  let lost = false
  let disposing = false
  let disposePromise: Promise<void> | undefined
  let extensionCommands: ReadonlySet<string> = new Set()
  /** Every command name pi lists (its own `trust` would win over this backend's). */
  let piCommands: ReadonlySet<string> = new Set()
  /** A trust restart asked for while a turn was running. */
  let restartAfterTurn = false
  const listeners = new Set<Listener>()
  const backlog: [readonly AgentEvent[], AgentEventMeta][] = []
  let replayHistory: readonly AgentEvent[] | undefined = replay

  const emit = (events: readonly AgentEvent[], wake: AgentEventMeta['wake'] = 'sync', duringDispose = false): void => {
    if ((disposing && !duringDispose) || events.length === 0) return
    const meta: AgentEventMeta = { replay: false, wake }
    if (listeners.size === 0) {
      backlog.push([events, meta])
      return
    }
    for (const listener of [...listeners]) {
      try {
        listener(events, meta)
      } catch (error) {
        debug(`pi: listener failed (${errorText(error)})`)
      }
    }
  }

  const status = (): AgentSessionStatus => {
    if (disposing) return 'disposed'
    if (dialogs.size > 0) return 'requires-action'
    return running ? 'running' : 'idle'
  }
  let lastStatus: AgentSessionStatus = running ? 'running' : 'idle'
  const publishStatus = (): void => {
    const next = status()
    if (next === lastStatus || next === 'disposed' || next === 'starting') return
    lastStatus = next
    emit([{ type: 'session.status', status: next }])
  }

  /** A restart in progress (see `relink`). */
  let relinking: Promise<void> | undefined
  /** A command to the current child; one sent during a restart goes to the new child. */
  const request = async (type: string, params?: Rec, options?: { readonly timeoutMs?: number }): Promise<unknown> => {
    while (relinking !== undefined) await relinking
    return link.request(type, params, options)
  }

  const dialogs = createPiDialogs({
    respond: record => link.send(record),
    emit: events => { emit(events, 'sync', true); publishStatus() },
    debug,
  })

  const trust = createPiTrustPrompt({
    cwd: deps.cwd,
    env: deps.env,
    emit: events => emit(events, 'sync', true),
    trusted: () => childTrusted,
    restart: () => restart(),
  })

  const input = createPiInput({
    request,
    emit: events => emit(events),
    running: () => running,
    extensionCommands: () => extensionCommands,
    local: text => {
      // pi's `/trust` belongs to its own interface; here it opens the question.
      if (!/^\/trust(?:\s|$)/u.test(text.trim()) || piCommands.has('trust')) return false
      trust.ask('command')
      return true
    },
    beforeAbort: () => dialogs.withdrawAll(),
    noteCancel: () => { ctx.cancelRequested = true },
    debug,
  })

  const live = createLiveTranslator(ctx, { claimUser: text => input.claimUser(text) })

  /** Take in a `get_state` answer: what pi does not announce (a model
   *  switch, a clamped thinking level) and the session file. */
  const applyState = (next: Rec): void => {
    const nextModel = modelOf(next.model)
    if (nextModel !== undefined && (nextModel.id !== model?.id || nextModel.provider !== model?.provider)) {
      model = nextModel
      ctx.model = nextModel.id
      ctx.contextWindow = nextModel.contextWindow
      emit([
        { type: 'model.changed', model: nextModel.id, ...(nextModel.provider === '' ? {} : { provider: nextModel.provider }), source: 'user' },
        ...(nextModel.contextWindow === undefined ? [] : [{ type: 'context.capacity' as const, contextWindow: nextModel.contextWindow }]),
      ])
    }
    const level = str(next.thinkingLevel)
    if (level !== undefined && level !== thinkingLevel) {
      thinkingLevel = level
      emit([{ type: 'effort.changed', effort: level }])
    }
    sessionFile = str(next.sessionFile) ?? sessionFile
  }

  const refreshState = async (): Promise<void> => {
    try {
      const next = rec(await request('get_state'))
      if (next !== undefined) applyState(next)
    } catch (error) {
      debug(`pi: get_state failed (${errorText(error)})`)
    }
  }

  const refreshLevels = async (via: typeof request = request): Promise<void> => {
    try {
      levels = strings(rec(await via('get_available_thinking_levels'))?.levels)
    } catch (error) {
      debug(`pi: thinking levels unavailable (${errorText(error)})`)
    }
  }

  handle = (event: PiRpcEvent): void => {
    if (disposing || lost) return
    switch (event.type) {
      case 'agent_start':
        if (!running) {
          running = true
          publishStatus()
        }
        return
      case 'extension_ui_request':
        dialogs.request(event)
        return
      case 'queue_update':
        return
      case 'thinking_level_changed': {
        const level = str(event.level)
        if (level !== undefined) thinkingLevel = level
        break
      }
      default:
        break
    }
    const { events, wake } = live.event(event)
    emit(events, wake)
    if (event.type === 'agent_settled') {
      running = false
      publishStatus()
      if (restartAfterTurn) {
        restartAfterTurn = false
        restart()
      }
    }
  }

  /** The child is gone for good: the open turn closes as an error, what
   *  waited is dropped, and input is refused from now on. */
  const lose = (text: string): void => {
    lost = true
    running = false
    dialogs.withdrawAll()
    trust.withdraw()
    emit([
      ...live.forceClose({ kind: 'error', message: text }),
      ...input.reset(),
      { type: 'notice', level: 'error', key: 'pi-exit', text },
      { type: 'session.status', status: 'idle' },
    ])
    lastStatus = 'idle'
  }

  const onExit = (info: PiExitInfo): void => {
    if (disposing) return
    const tail = info.stderr.slice(-3).join(' · ')
    lose(piText('pi-process-exited', { err: tail === '' ? `code ${info.code ?? info.signal ?? '?'}` : tail }))
  }
  let offExit = link.onExit(onExit)

  /** Restart pi on this session with the trust decided by now. The old
   *  child goes first (one writer per session file); the new one must open
   *  the same session. A failure loses the session, as a crash does. */
  const relink = async (): Promise<void> => {
    if (disposing || lost) return
    // A later answer (during the turn this waited for) may have undone it.
    if (piChildTrusted(deps.cwd, deps.env) === childTrusted) return
    // One keyed toast: the outcome below replaces it (trust-prompt.ts).
    emit([{ type: 'notice', level: 'notice', key: 'pi-trust', text: piText('pi-trust-restarting') }])
    dialogs.withdrawAll()
    offEvent()
    offExit()
    try {
      await link.close()
      if (disposing) return
      const file = sessionFile !== undefined && existsSync(sessionFile) ? sessionFile : undefined
      link = deps.respawn({ sessionId, ...(file === undefined ? {} : { sessionFile: file }) })
      offEvent = link.onEvent(event => handle?.(event))
      offExit = link.onExit(onExit)
      const next = rec(await link.request('get_state', {}, { timeoutMs: startTimeoutMs }))
      if (disposing) return
      if (str(next?.sessionId) !== sessionId) throw new Error(`pi opened session ${str(next?.sessionId) ?? '?'}, not ${sessionId}`)
      childTrusted = piChildTrusted(deps.cwd, deps.env)
      applyState(next!)
    } catch (error) {
      // A child that died at startup was already lost through its exit.
      if (disposing || lost) return
      offEvent()
      offExit()
      void link.close({ graceMs: 500 })
      lose(piText('pi-trust-restart-failed', { err: errorText(error) }))
      return
    }
    // The new child's thinking levels and commands (project prompts,
    // skills and extensions come and go with trust).
    await refreshLevels(link.request.bind(link))
    try {
      emit([{ type: 'commands.changed', commands: await listCommands(link.request.bind(link)) }])
    } catch (error) {
      debug(`pi: get_commands failed (${errorText(error)})`)
    }
    emit([{ type: 'notice', level: 'notice', key: 'pi-trust', text: piText(childTrusted ? 'pi-trust-applied' : 'pi-trust-revoked') }])
  }

  /** Restart for a changed trust decision, once the running turn ends. */
  const restart = (): void => {
    if (disposing || lost) return
    if (running) {
      if (!restartAfterTurn) emit([{ type: 'notice', level: 'notice', key: 'pi-trust', text: piText('pi-trust-deferred') }])
      restartAfterTurn = true
      return
    }
    const run = (relinking ?? Promise.resolve()).then(relink)
    relinking = run
    void run.finally(() => { if (relinking === run) relinking = undefined })
  }

  const version = deps.executable.version
  const drift = piVersionDrift(version)
  emit([{
    type: 'session.ready',
    sessionId,
    cwd: deps.cwd,
    model: model?.id ?? '',
    ...(model === undefined || model.provider === '' ? {} : { provider: model.provider }),
    ...(str(state.sessionName) === undefined ? {} : { title: str(state.sessionName)! }),
    ...(thinkingLevel === undefined ? {} : { effort: thinkingLevel }),
    ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(version === undefined ? {} : { backendVersion: version }),
  }])
  if (drift !== undefined) emit([{ type: 'notice', level: 'warning', key: 'pi-drift', text: piText('pi-version-drift', { version: drift, validated: VALIDATED_PI_VERSIONS.join(', ') }) }])
  if (model === undefined) emit([{ type: 'notice', level: 'warning', key: 'pi-no-model', text: piText('pi-no-model') }])
  if (model?.contextWindow !== undefined) emit([{ type: 'context.capacity', contextWindow: model.contextWindow }], 'none')
  if (thinkingLevel !== undefined) emit([{ type: 'effort.changed', effort: thinkingLevel }], 'none')
  const rememberedColor = deps.prefs.read().colors?.[sessionId]
  if (rememberedColor !== undefined) emit([{ type: 'session.color', color: rememberedColor }], 'none')
  if (running) emit([{ type: 'session.status', status: 'running' }], 'none')
  lastStatus = running ? 'running' : 'idle'
  for (const event of held.splice(0)) handle(event)
  if (askTrust) trust.ask('open')

  /** The live branch a fork or rewind copies: pi's own entries, read from
   *  the child (never a file pi may be appending to), and the session file. */
  const branchSource = async (): Promise<PiBranchSource> => {
    const file = sessionFile
    if (file === undefined || !existsSync(file)) throw new Error(piText('pi-fork-unsaved'))
    const answer = rec(await request('get_entries'))
    return { file, entries: arr(answer?.entries), leafId: answer?.leafId === null ? null : str(answer?.leafId) }
  }

  /** pi's commands (extension commands, prompt templates, skills), plus
   *  `/trust` unless pi lists one of that name. */
  const listCommands = async (via: typeof request = request): Promise<CommandInfo[]> => {
    const answer = rec(await via('get_commands'))
    const rows = arr(answer?.commands).map(rec).filter((row): row is Rec => row !== undefined && str(row.name) !== undefined)
    extensionCommands = new Set(rows.filter(row => row.source === 'extension').map(row => str(row.name)!))
    piCommands = new Set(rows.map(row => str(row.name)!))
    const list: CommandInfo[] = rows.map(row => {
      const description = str(row.description)
      return { name: str(row.name)!, ...(description === undefined || description === '' ? {} : { description }) }
    })
    return piCommands.has('trust') ? list : [...list, { name: 'trust', description: piText('pi-trust-command') }]
  }

  /** The last catalog read (the picker previews efforts from it). */
  let catalog: readonly Rec[] = []
  const listModels = async (): Promise<readonly ModelOption[]> => {
    const answer = rec(await request('get_available_models'))
    catalog = arr(answer?.models).map(rec).filter((row): row is Rec => row !== undefined && (str(row.id) ?? '') !== '')
    return catalog.map(row => {
      const provider = str(row.provider) ?? ''
      const id = str(row.id)!
      return { ...(provider === '' ? {} : { provider }), id, label: str(row.name) ?? id }
    })
  }

  const session: AgentSession = {
    ref: { backendId: PI_BACKEND_ID, sessionId },
    cwd: deps.cwd,
    get status() { return status() },
    capabilities: {
      native: {},
      questions: {
        respond: (requestId, answers) => {
          if (trust.owns(requestId)) void trust.respond(requestId, answers)
          else dialogs.respond(requestId, answers)
        },
        cancel: requestId => {
          if (trust.owns(requestId)) trust.cancel(requestId)
          else dialogs.cancel(requestId)
        },
      },
      models: {
        // pi serves many providers, and one model id may come from several.
        routes: 'providers',
        list: listModels,
        current: (): ModelRef => ({ ...(model === undefined || model.provider === '' ? {} : { provider: model.provider }), model: model?.id ?? '' }),
        async set(ref) {
          // The channel names the provider; a bare id still lands on the
          // current provider when it serves the id, else the first that does.
          let provider = ref.provider
          if (provider === undefined || provider === '') {
            if (catalog.length === 0) await listModels().catch(() => [])
            provider = str(findPiModelRow(catalog, ref.model, undefined, model?.provider)?.provider)
          }
          if (provider === undefined || provider === '') return { kind: 'refused', reason: piText('pi-model-unknown', { model: ref.model }) }
          try {
            await request('set_model', { provider, modelId: ref.model })
          } catch (error) {
            return { kind: 'refused', reason: errorText(error) }
          }
          await refreshLevels()
          await refreshState()
          return { kind: 'switched' }
        },
      },
      effort: {
        levels: () => levels.map(id => ({ id, label: id })),
        forModel: ref => {
          const row = findPiModelRow(catalog, ref.model, ref.provider, model?.provider)
          const forRow = piThinkingLevels(row)
          const landing = clampPiThinkingLevel(row, thinkingLevel)
          return { levels: forRow.map(id => ({ id, label: id })), ...(landing === undefined ? {} : { defaultEffort: landing }) }
        },
        current: () => thinkingLevel,
        async set(id) {
          if (id === null) return
          if (levels.length > 0 && !levels.includes(id)) throw new Error(piText('effort-invalid', { id, ids: levels.join(', ') }))
          await request('set_thinking_level', { level: id })
          await refreshState()
        },
      },
      compact: {
        async run() {
          await request('compact', {}, { timeoutMs: 0 })
        },
      },
      commands: { list: () => listCommands() },
      images: { limits: PI_IMAGE_LIMITS },
      context: {
        async usage() {
          const stats = rec(await request('get_session_stats'))
          const usage = rec(stats?.contextUsage)
          const max = num(usage?.contextWindow) ?? model?.contextWindow
          const used = num(usage?.tokens) ?? 0
          return { used, ...(max === undefined ? {} : { max }), categories: [] }
        },
      },
      rename: {
        async rename(title) {
          await request('set_session_name', { name: title })
        },
      },
      fork: {
        // A copy through the anchor's turn (all of it without one); the live
        // session and its child are not touched (session/branch.ts).
        async fork(anchor, title) {
          const source = await branchSource()
          let cut: Parameters<typeof writePiBranch>[1] = { kind: 'all' }
          if (anchor !== undefined) {
            const entry = resolveUserEntry(source, anchor, ctx.userRows)
            if (entry === undefined) throw new Error(piText('pi-anchor-missing'))
            cut = { kind: 'through', entryId: str(entry.id)! }
          }
          const written = writePiBranch(source, cut, title === undefined ? {} : { title })
          return { backendId: PI_BACKEND_ID, sessionId: written.sessionId }
        },
      },
      rewind: {
        // The conversation before the picked message, as a new session the
        // channel then opens; pi keeps no file snapshots to restore.
        async rewind(anchor, mode) {
          if (mode !== 'conversation') return { kind: 'refused', reason: piText('pi-rewind-files-unsupported') }
          const source = await branchSource()
          const entry = resolveUserEntry(source, anchor, ctx.userRows)
          if (entry === undefined) return { kind: 'refused', reason: piText('pi-anchor-missing') }
          const written = writePiBranch(source, { kind: 'before', entryId: str(entry.id)! })
          return { kind: 'rewound', session: { backendId: PI_BACKEND_ID, sessionId: written.sessionId } }
        },
      },
      color: {
        current: () => deps.prefs.read().colors?.[sessionId] ?? '',
        set: color => {
          const colors = { ...deps.prefs.read().colors }
          delete colors[sessionId]
          if (color !== '') colors[sessionId] = color
          deps.prefs.write({ colors })
          emit([{ type: 'session.color', color }])
        },
      },
      diagnostics: {
        lines: (): readonly string[] => [
          piText('pi-doctor-cli', { path: deps.executable.path, source: deps.executable.source, version: version ?? piText('doctor-unknown') }),
          ...(drift === undefined ? [] : [piText('pi-version-drift', { version: drift, validated: VALIDATED_PI_VERSIONS.join(', ') })]),
          ...(deps.agentDir === undefined ? [] : [piText('pi-doctor-agent-dir', { dir: deps.agentDir })]),
          piText('pi-doctor-session', { id: sessionId, file: sessionFile ?? piText('pi-doctor-unsaved') }),
          piText('pi-doctor-model', { provider: model?.provider || piText('doctor-unknown'), model: model?.id || piText('doctor-unknown'), level: thinkingLevel ?? piText('doctor-unknown') }),
          ...(lost ? [piText('pi-doctor-exited')] : []),
        ],
      },
    },
    history(): Promise<readonly AgentEvent[]> {
      const events = replayHistory ?? []
      replayHistory = undefined
      return Promise.resolve(events)
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      if (backlog.length > 0) {
        queueMicrotask(() => {
          if (!listeners.has(listener)) return
          for (const [events, meta] of backlog.splice(0)) listener(events, meta)
        })
      }
      return () => { listeners.delete(listener) }
    },
    submit(next, placement) {
      if (disposing) return Promise.reject(new Error(piText('pi-session-closed')))
      if (lost) return Promise.reject(new Error(piText('pi-session-lost')))
      return input.submit(next, placement)
    },
    async cancel(cause: CancelCause) {
      if (disposing || lost) return { stillQueued: [], outcome: 'unknown' }
      if (cause === 'switch' || cause === 'dispose') {
        dialogs.withdrawAll()
        trust.withdraw()
      }
      return input.cancel(cause)
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposePromise = (async () => {
        if (!lost) {
          dialogs.withdrawAll()
          if (running) await input.abort().catch(() => false)
        }
        trust.withdraw()
        disposing = true
        offEvent()
        offExit()
        await link.close()
        emit([{ type: 'session.status', status: 'disposed' }], 'none', true)
        listeners.clear()
        backlog.length = 0
      })()
      return disposePromise
    },
  }
  // The extension command names decide which prompts record no message.
  void session.capabilities.commands!.list().catch(error => { debug(`pi: get_commands failed (${errorText(error)})`) })
  return session
}
