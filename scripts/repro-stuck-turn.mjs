#!/usr/bin/env node
/**
 * Headless regression for escaping a WEDGED turn (the tool ignores the abort).
 *
 * Bug under guard: after a tool call stops responding, the first interrupt
 * leaves the turn running forever — `channel.working` / `cancelPending` stay
 * true. Today repeated Esc is a silent no-op (`InputActions.cancel()` early
 * returns while `cancelInFlight`), Enter steers into a turn that will never
 * advance, and `/restart` is refused by the `channel.working` gate, so the
 * user has no in-app way out.
 *
 * The script renders the REAL `<Chat>` (compiled lib) against a fake channel
 * exactly like `scripts/repro-ctrlc.tsx` / `scripts/verify-queue.mjs` do
 * (headless xterm, fake TTY streams), drives keys over stdin and asserts only
 * observable behavior: how many effective `cancel()` calls the channel saw,
 * whether a notice was raised and painted, whether `onRestart` fired, and what
 * the docked-queue baseline does. It never asserts on invented future copy.
 *
 * Groups / checks (ids in brackets; the serialized id is the flip handle):
 *   A. first Esc interrupts once; a second Esc while that abort is converging
 *      must not be a silent no-op [A1, A2]
 *   B. a permanently pending abort (cancelPending never clears) still answers
 *      Esc and Enter instead of swallowing them [B1, B2]
 *   C. /restart typed while working reaches `onRestart` (recovery), and still
 *      works when idle [C1, C2, C3]
 *   D. Enter while the abort is stuck must not promise immediate processing
 *      of the steer [D1]
 *   E. baseline sanity that must stay green: empty Enter while idle sends the
 *      docked queue (FIFO, once) [E1, E2, E3]
 *   F. a channel action that throws synchronously must not eat the draft: the
 *      send is reported and the text stays editable (Ink's stdin pump only
 *      logs the throw to stderr) [F1, F2, F3]; the dock rows survive a
 *      throwing deliverDocked with no false "sent" claim [F4, F5]
 *
 * The recovery checks below were all red before the fix (they are the bug's
 * acceptance criteria): A2, B1, C1 and D1. `EXPECTED_FAILING_TODAY` is empty
 * now — keep it empty unless a red test is deliberately landed ahead of its
 * fix.
 *
 * Run after a build (plain node against `lib/types/`):
 *     node scripts/repro-stuck-turn.mjs
 * After the fix, require every recovery check to pass without editing:
 *     node scripts/repro-stuck-turn.mjs --expect-fixed
 * Exit code is non-zero when any required check fails.
 *
 * Two fake-channel seams are deliberate:
 * - `SUPPRESS_CANCEL_WHILE_PENDING` mirrors today's real `InputActions.cancel()`
 *   (`if (input.cancelInFlight) return`) and is what makes repeated Esc a
 *   no-op. If the fix moves the re-issue into the channel, flip this to false;
 *   the assertions do not change.
 * - `PROBE_MS` bounds the "did anything happen?" poll for negative/async
 *   expectations. A time-based cancel watchdog with a longer threshold can be
 *   exercised with `REPRO_STUCK_PROBE_MS=<ms>`.
 */

import { closeSync, openSync } from 'node:fs'

delete process.env.NO_COLOR
process.env.FORCE_COLOR = '3'
// Assertions are language-neutral (notice arrays + parameterized patterns),
// but pin English so rendered toast prefixes are deterministic.
process.env.DSH_TUI_LANG = 'en'

const [{ Writable, PassThrough }, ReactMod, xtermMod, ui, chatMod, i18n, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/screens/Chat.js'),
  import('../lib/types/i18n.js'),
  import('./lib/term-test.mjs'),
])
const React = ReactMod.default
const { Terminal: XTerm } = xtermMod.default
const { Chat } = chatMod
const { setLang } = i18n
const { render } = ui
const { settle, settled, viewportLines, screenHas } = termTest

// ── parameters / flip handles ───────────────────────────────────────────────
const COLS = 110
const ROWS = 40

/** Ids expected to fail even after the fix (deliberately red work). Empty:
 *  every check below is a fix acceptance criterion. */
const EXPECTED_FAILING_TODAY = new Set([])

/** Mirrors the real channel seam today. FLIP to false if the fix lets the
 *  channel re-issue an abort while one is already in flight. */
const SUPPRESS_CANCEL_WHILE_PENDING = true

/** How long a "must respond" / "must not claim X" probe may wait for the
 *  effect that a fix would produce. Overridable for watchdog-based designs. */
const PROBE_MS = Number.parseInt(process.env.REPRO_STUCK_PROBE_MS ?? '', 10) || 1500

/** The immediate-processing claim the steer notice makes today
 *  ("Interrupted · processed next" / "已插话 · 下一步立即处理"). D1 rejects
 *  this copy family while `cancelPending` means the abort has not converged.
 *  PARAMETERIZE: extend/adjust here when product copy changes. */
const IMMEDIATE_PROCESSING_CLAIM = /immediate|next|立即|下一步/i

const expectFixed = process.argv.includes('--expect-fixed')
const isExpectedFailing = id => !expectFixed && EXPECTED_FAILING_TODAY.has(id)

// ── PASS/FAIL reporting ─────────────────────────────────────────────────────
let passed = 0
let failed = 0
let knownFailing = 0
let unexpected = 0
const staleMarkers = []

function check(id, name, ok, extra = '') {
  const expectedFailing = isExpectedFailing(id)
  const suffix = extra === '' ? '' : `  (${extra})`
  if (ok) {
    passed += 1
    const stale = expectedFailing && !expectFixed
    console.log(`PASS: ${id} ${name}${suffix}`)
    if (stale) {
      staleMarkers.push(id)
      console.log(`      note: ${id} is in EXPECTED_FAILING_TODAY but passes — flip/remove that marker`)
    }
    return
  }
  failed += 1
  if (expectedFailing) {
    knownFailing += 1
    console.log(`FAIL: ${id} ${name}  [known-failing today]${suffix}`)
  } else {
    unexpected += 1
    console.log(`FAIL: ${id} ${name}${suffix}`)
  }
}

const banner = title => console.log(`\n── ${title} ──`)

// ── headless harness ────────────────────────────────────────────────────────
/** Ink's unmount restores terminal modes with synchronous writes to the fake
 *  stdout's `.fd` (falling back to the process's real fd 1). Route those to
 *  /dev/null so per-scenario unmounts do not spray restore sequences into the
 *  PASS/FAIL stream; the rendered screen still comes from the xterm above. */
const SINK_FD = openSync('/dev/null', 'w')

function makeStreams(term) {
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
  stdout.columns = COLS
  stdout.rows = ROWS
  stdout.isTTY = true
  stdout.fd = SINK_FD
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

/**
 * Fake ChannelUi with the slices Chat/PromptInput read, plus probe counters.
 * `cancel()` deliberately mirrors src/dsh-adapter/channel/input-actions.ts:
 * a repeated call while the previous cancel is still in flight returns
 * silently and leaves `cancelPending` set — the silent dead end this script
 * documents. Everything users can observe goes through `notify()` (notice
 * array + emit → the real composer toast) and the returned counters.
 */
function makeChannel({ working = false, cancelPending = false, pending = [] } = {}) {
  const listeners = new Set()
  const probe = {
    uiCancelCalls: 0,
    effectiveCancels: 0,
    suppressedCancels: 0,
    steerCalls: [],
    submitCalls: [],
    deliverDockedCalls: 0,
    delivered: [],
    onRestartCalls: 0,
  }
  let noticeSeq = 0
  const channel = {
    // Determinism: the idle whale animation must not repaint the probe window.
    whaleIdle: false,
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'stuck-turn-repro',
    agentId: 'stuck-turn-repro',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working,
    cancelPending,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: Date.now(),
    lastUserText: '',
    pending: [...pending],
    commandList: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'high',
    effortLevels: [],
    activityEnabled: false,
    contextBarEnabled: true,
    statusBar: {},
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    sessionColor: '',
    promptSessionLabel: false,

    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    emit() {
      channel.version += 1
      for (const cb of listeners) cb()
    },
    notify(text, options = {}) {
      channel.notifications.push({
        id: ++noticeSeq,
        text: String(text),
        timeoutMs: options.timeoutMs ?? 4000,
        ...(options.color === undefined ? {} : { color: options.color }),
      })
      channel.emit()
      return () => {}
    },
    cancel() {
      probe.uiCancelCalls += 1
      // Real seam: ignore a repeated interrupt until the aborted turn produces
      // its terminal event; `cancelPending` mirrors that window in the UI.
      if (SUPPRESS_CANCEL_WHILE_PENDING && channel.cancelPending) {
        probe.suppressedCancels += 1
        return
      }
      probe.effectiveCancels += 1
      channel.cancelPending = true
      channel.emit()
    },
    steer(text) { probe.steerCalls.push(text) },
    submit(text) { probe.submitCalls.push(text) },
    deliverDocked() {
      probe.deliverDockedCalls += 1
      const docked = channel.pending.filter(item => item.docked === true)
      channel.pending = channel.pending.filter(item => item.docked !== true)
      probe.delivered.push(...docked.map(item => item.text))
      channel.emit()
      return docked.length
    },
    interruptAndDock() { return 0 },
    interruptAndDeliver() { return 0 },
    removePending() { return true },
    clear() {},
    cycleMode() {},
    commandCompletions() { return [] },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    pushLocal() {},
    loadOlder() { return 0 },
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'moon8',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
  }
  return { channel, probe }
}

const emptyQuestionStore = {
  subscribe: () => () => {},
  getSnapshot: () => null,
  answerCurrent: () => {},
}

/** Render the real Chat and wait for the composer to be on screen. */
async function mount(channel, onRestart = () => {}) {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
  const { stdout, stderr, stdin } = makeStreams(term)
  const instance = await render(
    React.createElement(Chat, {
      channel,
      questionStore: emptyQuestionStore,
      onExit() {},
      onRestart,
    }),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  const ready = await settled(() => screenHas(term, '❯'), { timeoutMs: 8000 })
  if (!ready) {
    await instance.unmount()
    throw new Error('harness: <Chat> composer never rendered (prompt glyph ❯ not on screen)')
  }
  return { term, stdin, instance }
}

const screen = term => viewportLines(term).join('\n')

/**
 * True when a notice is actually painted. The toast right-aligns and may be
 * truncated for long copy, so accept either end of the text; this is the
 * screen-visible half of every "user-visible response" assertion.
 */
function noticeOnScreen(term, text) {
  const chars = [...String(text)]
  const head = chars.slice(0, 12).join('')
  const tail = chars.slice(-12).join('')
  const view = screen(term)
  return (head !== '' && view.includes(head)) || (tail !== '' && view.includes(tail))
}

/** Bounded poll for an effect that a fix would produce (never a bare sleep). */
async function probe(fn) {
  await settle(fn, { timeoutMs: PROBE_MS })
  return Boolean(fn())
}

/** Type a line, wait for the composer echo, then press Enter. */
async function typeAndEnter(term, stdin, text) {
  const before = screen(term)
  stdin.write(text)
  await settled(() => screen(term) !== before && screen(term).includes(text), { timeoutMs: 4000 })
  stdin.write('\r')
}

// ── scenario A: repeated Esc while the first abort is still converging ──────
async function scenarioA() {
  banner('A. repeated Esc while the first abort is still converging')
  const { channel, probe: calls } = makeChannel({ working: true })
  const { term, stdin, instance } = await mount(channel)

  stdin.write('\x1b')
  const first = await settled(() => calls.effectiveCancels === 1 && channel.cancelPending === true)
  check(
    'A1',
    'first Esc while working issues exactly one effective cancel and arms cancelPending',
    first,
    `uiCalls=${calls.uiCancelCalls} effective=${calls.effectiveCancels} cancelPending=${channel.cancelPending}`,
  )

  const effectiveBefore = calls.effectiveCancels
  const noticesBefore = channel.notifications.length
  stdin.write('\x1b')
  const responded = await probe(
    () => calls.effectiveCancels > effectiveBefore || channel.notifications.length > noticesBefore,
  )
  check(
    'A2',
    'second Esc during cancelPending re-issues an effective abort or raises a user-visible notice',
    responded,
    `uiCalls=${calls.uiCancelCalls} retryEffective=${calls.effectiveCancels - effectiveBefore} suppressed=${calls.suppressedCancels} newNotices=${channel.notifications.length - noticesBefore}`,
  )

  await instance.unmount()
}

// ── scenarios B + D: a permanently pending abort ────────────────────────────
async function scenarioB() {
  banner('B/D. wedged turn: cancelPending never clears')
  const { channel, probe: calls } = makeChannel({ working: true, cancelPending: true })
  // The user already interrupted once; that cancel never converged.
  calls.uiCancelCalls = 1
  calls.effectiveCancels = 1
  const { term, stdin, instance } = await mount(channel)

  const effectiveBefore = calls.effectiveCancels
  const noticesBefore = channel.notifications.length
  stdin.write('\x1b')
  const escResponded = await probe(
    () => calls.effectiveCancels > effectiveBefore || channel.notifications.length > noticesBefore,
  )
  check(
    'B1',
    'Esc while the abort is wedged raises an effective retry or a user-visible notice',
    escResponded,
    `retryEffective=${calls.effectiveCancels - effectiveBefore} uiCalls=${calls.uiCancelCalls} suppressed=${calls.suppressedCancels} newNotices=${channel.notifications.length - noticesBefore}`,
  )

  // Enter while wedged: document that SOMETHING is painted today, even though
  // D1 rejects its promise. (A fix may replace the notice; presence stays.)
  const steerNoticesFrom = channel.notifications.length
  await typeAndEnter(term, stdin, 'one more thing')
  const steered = await settled(() => calls.steerCalls.length === 1 && channel.notifications.length > steerNoticesFrom, { timeoutMs: 4000 })
  const steerNotices = channel.notifications.slice(steerNoticesFrom).map(item => item.text)
  const lastSteerNotice = steerNotices.at(-1) ?? ''
  const painted = lastSteerNotice !== '' && (await settled(() => noticeOnScreen(term, lastSteerNotice), { timeoutMs: 4000 }))
  check(
    'B2',
    'Enter while the abort is wedged yields a user-visible response (steer notice painted)',
    steered && painted,
    `steers=${JSON.stringify(calls.steerCalls)} notices=${JSON.stringify(steerNotices)}`,
  )

  const claiming = steerNotices.filter(text => IMMEDIATE_PROCESSING_CLAIM.test(text))
  check(
    'D1',
    'Enter while the abort is stuck does not claim immediate processing of the steer',
    steered && claiming.length === 0,
    claiming.length === 0 ? JSON.stringify(steerNotices) : `claims=${JSON.stringify(claiming)}`,
  )

  await instance.unmount()
}

// ── scenario C: /restart as the recovery hatch ──────────────────────────────
async function scenarioC() {
  banner('C. /restart while working (recovery hatch)')
  const { channel, probe: calls } = makeChannel({ working: true })
  const { term, stdin, instance } = await mount(channel, () => { calls.onRestartCalls += 1 })

  const noticesBefore = channel.notifications.length
  await typeAndEnter(term, stdin, '/restart')
  const answered = await probe(
    () => channel.notifications.length > noticesBefore || calls.onRestartCalls > 0,
  )
  check(
    'C2',
    '/restart while working is answered with a notice or a restart (no silent swallow)',
    answered,
    `onRestart=${calls.onRestartCalls} notices=${JSON.stringify(channel.notifications.slice(noticesBefore).map(item => item.text))}`,
  )
  check(
    'C1',
    '/restart while working reaches onRestart (recovery allowed mid-turn)',
    calls.onRestartCalls === 1,
    `onRestartCalls=${calls.onRestartCalls} gateNotice=${JSON.stringify(channel.notifications.at(-1)?.text ?? null)}`,
  )

  // Idle control: the same key path must reach onRestart with no turn running
  // (proves the harness can observe the hook at all). Relative to the count
  // after the working-state attempt so this passes both today and post-fix.
  channel.working = false
  channel.emit()
  await settle(() => !screen(term).includes('esc to interrupt'), { timeoutMs: 4000 })
  const idleRestartFrom = calls.onRestartCalls
  await typeAndEnter(term, stdin, '/restart')
  const idleRestart = await settled(() => calls.onRestartCalls === idleRestartFrom + 1, { timeoutMs: 4000 })
  check(
    'C3',
    'idle /restart reaches onRestart (baseline control)',
    idleRestart,
    `onRestartCalls=${calls.onRestartCalls} (from ${idleRestartFrom})`,
  )

  await instance.unmount()
}

// ── scenario E: docked-queue baseline (must stay green) ─────────────────────
async function scenarioE() {
  banner('E. baseline: empty Enter while idle sends the docked queue')
  const { channel, probe: calls } = makeChannel({
    working: false,
    pending: [
      { id: 'dock-1', text: 'held one', placement: 'followup', docked: true },
      { id: 'dock-2', text: 'held two', placement: 'followup', docked: true },
    ],
  })
  const { term, stdin, instance } = await mount(channel)

  const noticesBefore = channel.notifications.length
  stdin.write('\r')
  await settled(() => calls.deliverDockedCalls > 0, { timeoutMs: 4000 })
  check(
    'E1',
    'empty Enter sends the dock exactly once, in FIFO order',
    calls.deliverDockedCalls === 1 && JSON.stringify(calls.delivered) === JSON.stringify(['held one', 'held two']),
    `deliverCalls=${calls.deliverDockedCalls} delivered=${JSON.stringify(calls.delivered)}`,
  )
  check(
    'E2',
    'the dock is emptied after delivery',
    channel.pending.length === 0,
    `pending=${JSON.stringify(channel.pending.map(item => item.text))}`,
  )
  const dockNotice = channel.notifications.slice(noticesBefore).at(-1)?.text ?? ''
  const painted = await settled(() => noticeOnScreen(term, dockNotice), { timeoutMs: 4000 })
  check(
    'E3',
    'the dock-sent notice is user-visible on screen',
    dockNotice !== '' && painted,
    JSON.stringify(channel.notifications.slice(noticesBefore).map(item => item.text)),
  )

  await instance.unmount()
}

// ── scenario F: a synchronous channel throw must not eat the draft ──────────
async function scenarioF() {
  banner('F. synchronous channel throw: report the failure, keep the draft')
  const { channel, probe: calls } = makeChannel({ working: false })
  // The owner/lease check inside every ChannelUi mutate throws after a
  // lifetime race; Ink's stdin pump swallows it (stderr only).
  channel.submit = () => { throw new Error('dsh-tui: Channel lifetime has ended') }
  const { term, stdin, instance } = await mount(channel)

  const noticesBefore = channel.notifications.length
  await typeAndEnter(term, stdin, 'keep my text')
  const reported = await probe(() => channel.notifications.length > noticesBefore)
  const noticeText = channel.notifications.slice(noticesBefore).map(item => item.text).join(' | ')
  check(
    'F1',
    'a throwing submit is reported to the user (not just stderr)',
    reported && /send failed/i.test(noticeText),
    JSON.stringify(channel.notifications.slice(noticesBefore).map(item => item.text)),
  )
  check(
    'F2',
    'the draft survives the failed send and stays editable',
    await settled(() => screen(term).includes('keep my text'), { timeoutMs: 4000 }),
    JSON.stringify(screen(term).split('\n').filter(line => line.includes('keep my text'))),
  )
  check('F3', 'nothing was reported as submitted', calls.submitCalls.length === 0, JSON.stringify(calls.submitCalls))

  await instance.unmount()

  // A throwing deliverDocked must keep the rows (no false success toast).
  const docked = makeChannel({
    working: false,
    pending: [{ id: 'dock-x', text: 'still held', placement: 'followup', docked: true }],
  })
  docked.channel.deliverDocked = () => { throw new Error('dsh-tui: Channel lifetime has ended') }
  const second = await mount(docked.channel)
  const noticesFrom = docked.channel.notifications.length
  second.stdin.write('\r')
  await probe(() => docked.channel.notifications.length > noticesFrom)
  const dockNotices = docked.channel.notifications.slice(noticesFrom).map(item => item.text)
  check(
    'F4',
    'a throwing deliverDocked is reported and claims no success',
    dockNotices.some(text => /send failed/i.test(text)) && !dockNotices.some(text => /sent/i.test(text)),
    JSON.stringify(dockNotices),
  )
  check(
    'F5',
    'the dock rows survive the failed delivery',
    docked.channel.pending.length === 1 && docked.channel.pending[0]?.docked === true,
    JSON.stringify(docked.channel.pending.map(item => item.text)),
  )
  await second.instance.unmount()
}

// ── main ────────────────────────────────────────────────────────────────────
setLang('en')
try {
  await scenarioA()
  await scenarioB()
  await scenarioC()
  await scenarioE()
  await scenarioF()
} catch (error) {
  console.error(`\nHARNESS ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(2)
}

console.log('\n──────────────────────────────────────────────────────────────────────')
console.log(`SUMMARY: ${passed} passed, ${failed} failed (${knownFailing} expected/known-failing today, ${unexpected} unexpected)`)
if (expectFixed) {
  console.log('MODE: --expect-fixed — the recovery checks are required to pass.')
} else {
  if (EXPECTED_FAILING_TODAY.size > 0) {
    console.log(`Known-failing today: ${[...EXPECTED_FAILING_TODAY].join(', ')} (expected until the fix lands).`)
  }
  if (staleMarkers.length > 0) {
    console.log(`Stale expected-failing markers (now passing — flip them): ${staleMarkers.join(', ')}`)
  }
}
console.log(failed === 0 ? 'RESULT: all required checks passed' : `RESULT: ${failed} check(s) failed`)
closeSync(SINK_FD)
process.exit(failed === 0 ? 0 : 1)
