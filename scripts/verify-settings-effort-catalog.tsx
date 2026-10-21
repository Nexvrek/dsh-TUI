/** Current-route effort choices through the real Settings screen and form.
 * Run: node --import tsx/esm scripts/verify-settings-effort-catalog.tsx
 */
export {}
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
const [{ default: assert }, { PassThrough, Writable }, React, { Terminal }, { render, AlternateScreen }, { Settings }, { SETTING_DEFINITIONS }, { settled, settle, sleep, viewportLines }] = await Promise.all([
  import('node:assert/strict'), import('node:stream'), import('react'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Settings.js'), import('../src/settings/definitions.js'), import('./lib/term-test.mjs'),
])
const { SettingsForm } = await import('../src/dsh-adapter/settingsEditor.js')
let observedField: Parameters<InstanceType<typeof SettingsForm>['field']>[0] | undefined
const originalField = SettingsForm.prototype.field
SettingsForm.prototype.field = function (field) {
  if (field.optionsSource === 'effort') observedField = field
  return originalField.call(this, field)
}
const offered = () => observedField?.options?.map(option => option.value) ?? []
type Catalog = { efforts: { id: string; name: string }[]; defaultEffort: string | undefined }
const pending: { route: string; resolve(value: Catalog): void; reject(error: Error): void }[] = []
const writes: string[] = []
let stored = 'remembered-custom'
let revision = 1
// Real action and request middleware: form writes must reach the next request.
const { createModelActions } = await import('../src/dsh-adapter/channel/model-actions.js')
const { createModelSelection } = await import('../src/dsh-adapter/channel/model-selection.js')
const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
type Hook = (...args: unknown[]) => Promise<unknown>
const hooks = new Map<string, Hook>()
const owner = createChannelOwner()
const agent = {
  options: { provider: 'p', model: 'declared' },
  session: { requestHeader: () => ({ config: { provider: 'p', model: 'declared', reasoningEffort: 'xhigh' } }) },
  ctx: { on: (name: string, hook: Hook) => { hooks.set(name, hook); return () => hooks.delete(name) } },
}
const ctx = { on: () => () => {}, get: (name: string) => name === 'llm'
  ? { resolveModelInfo: async () => ({ reasoning: { efforts: ['medium', 'xhigh', 'ultra-custom'].map(id => ({ id, name: id })) } }) }
  : undefined }
const routing = createModelSelection(ctx as never, { owner, agent: () => agent as never })
routing.bind(agent as never, agent.options)
const state = { provider: 'p', model: 'declared', working: false, reasoningEffort: undefined as string | undefined, effortLevels: undefined as string[] | undefined, agentPreset: undefined, contextWindow: undefined, emit: () => {} }
const actions = createModelActions(ctx as never, state as never, {
  owner, binding: { capture: () => agent, isCurrent: (value: unknown) => value === agent } as never,
  selection: routing.selection, agent: () => agent as never, notify: () => {}, checkContextWarning: () => {},
})
await actions.applyPreferredEffort(true)
assert.equal(routing.selection.current?.reasoningEffort, 'xhigh', 'passive catalog refresh preserves restored effort')
const nextRequest = async () => {
  await hooks.get('system-prompt/assemble')!({}, {}, async () => ({ variables: agent.options }))
  return await hooks.get('agent/request')!({}, async () => ({ provider: 'p', model: 'declared' })) as { reasoningEffort?: string }
}
const host = {
  listNamespaces: () => [{ ns: 'fixture', revision, applies: 'live' as const, value: { effortDefault: stored }, user: {} }],
  write: async (_ns: string, ops: readonly { op: string; value?: unknown }[]) => {
    for (const op of ops) if (op.op === 'set') { stored = String(op.value); writes.push(stored); actions.setDefaultEffort(stored === 'auto' ? undefined : stored) }
    revision += 1
  },
  credentialConfigured: async () => false,
  writeCredential: async () => undefined,
}
const listeners = new Set<() => void>()
const channel = {
  version: 0, backendCapabilities: { backendId: 'fixture', effort: true },
  sessionRef: { backendId: 'fixture', sessionId: 'session-a' }, agentBindingGeneration: 1, agentId: 'a', provider: 'p', model: 'first', effortLevels: undefined as string[] | undefined,
  settingsHost: () => host,
  settingsSections: () => [{ ns: 'fixture', title: 'Fixture', fields: [{ ...SETTING_DEFINITIONS.effortDefault, path: ['effortDefault'], kind: 'select' as const, optionsSource: 'effort' as const, group: undefined, format: (value: unknown) => value === undefined || value === null ? 'persisted-fallback' : String(value) }] }],
  subscribeSettingsSections: () => () => {},
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  listEfforts: (route: { provider: string; model: string }) => new Promise<Catalog>((resolve, reject) => pending.push({ route: route.model, resolve, reject })),
}
const emit = () => { channel.version++; for (const listener of listeners) listener() }
// Use the production read projection: it reallocates detached arrays and
// capability objects on every unrelated version, while the settings host
// remains the stable fixture handle.
const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')
const lease = createChannelUiLease(() => true)
const projected = createChannelUi(channel as never, 'legacy', lease)
const screenChannel = Object.create(channel) as typeof channel
Object.defineProperties(screenChannel, {
  effortLevels: { get: () => projected.effortLevels },
  backendCapabilities: { get: () => projected.backendCapabilities },
})
class Stdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
class Stderr extends Writable { _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() } }
const terminal = new Terminal({ cols: 110, rows: 28, allowProposedApi: true })
class Stdout extends Writable {
  isTTY = true; columns = 110; rows = 28
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { terminal.write(String(chunk), callback) }
}
const stdin = new Stdin()
const app = await render(<AlternateScreen><Settings channel={screenChannel as never} onClose={() => {}} /></AlternateScreen>, {
  stdout: new Stdout() as never, stdin: stdin as never, stderr: new Stderr() as never, patchConsole: false, exitOnCtrlC: false,
})
const has = (text: string) => viewportLines(terminal, 28).join('\n').includes(text)
const wait = async (condition: () => boolean, message: string) => { assert.equal(await settled(condition, { timeoutMs: 4000 }), true, message) }
const cycle = async (value: string) => { const before = writes.length; stdin.write('\x1b[C'); await wait(() => writes.length > before && stored === value, `save ${value}`) }
try {
  await wait(() => pending.length === 1 && has('remembered-custom'), 'saved unsupported value remains readable while loading')
  assert.deepEqual(writes, [], 'opening never overwrites an unsupported global preference')
  const previousCapabilities = projected.backendCapabilities
  for (let index = 0; index < 5; index++) { emit(); await sleep(20) } // 固定窗:探针 Unrelated streaming emissions retain the in-flight lookup.
  assert.notEqual(projected.backendCapabilities, previousCapabilities, 'fixture exercises production projection churn')
  assert.equal(pending.length, 1, 'unrelated updates cannot restart or starve a pending catalog')
  pending[0]!.resolve({ efforts: [{ id: 'medium', name: 'Medium declared' }, { id: 'xhigh', name: 'Extra high declared' }, { id: 'ultra-custom', name: 'Custom declared' }], defaultEffort: 'medium' })
  // The catalog updates the retained SettingsForm as well as the visible row.
  await settle(() => offered().includes('ultra-custom'))
  await cycle('auto')
  await cycle('medium')
  await wait(() => has('Medium declared'), 'declared medium label rendered')
  await cycle('xhigh')
  await cycle('ultra-custom')
  await wait(() => routing.selection.current?.reasoningEffort === 'ultra-custom', 'form write reaches live model selection')
  assert.equal((await nextRequest()).reasoningEffort, 'ultra-custom', 'custom tier ships through real agent/request middleware')
  await wait(() => has('Custom declared'), 'declared custom label rendered')
  console.log('SCREEN effort custom tier\n' + viewportLines(terminal, 28).filter(line => line.trim()).join('\n'))
  channel.model = 'second'; emit()
  await wait(() => pending.length === 2 && has('ultra-custom'), 'saved unsupported value remains readable on route refresh')
  assert.deepEqual(offered(), ['auto'], 'saved value is readable, not advertised as supported')
  channel.model = 'third'; emit()
  await wait(() => pending.length === 3, 'third route replaces pending preview')
  pending[1]!.resolve({ efforts: [{ id: 'stale-only', name: 'Stale only' }], defaultEffort: 'stale-only' })
  pending[2]!.reject(new Error('metadata unavailable'))
  await sleep(100) // 固定窗:探针 A rejected or superseded lookup must not mutate the saved preference.
  assert.equal(stored, 'ultra-custom', 'failed refresh retains the saved preference')
  await cycle('auto')
  stdin.write('\x1b[C')
  await sleep(100) // 固定窗:探针 Cycling the only option must not introduce a different preference.
  assert.equal(stored, 'auto', 'only Auto remains selectable')
  assert.equal(writes.includes('stale-only'), false, 'late route cannot publish selectable tiers')
  channel.effortLevels = ['only-tier']; emit()
  await wait(() => pending.length === 4, 'capability refresh reloads the same route')
  pending[3]!.resolve({ efforts: [{ id: 'only-tier', name: 'Only declared' }], defaultEffort: 'only-tier' })
  await settle(() => offered().includes('only-tier'))
  await cycle('only-tier')
  channel.model = 'no-reasoning'; emit()
  await wait(() => pending.length === 5, 'nonreasoning route lookup')
  pending[4]!.resolve({ efforts: [], defaultEffort: undefined })
  await settle(() => offered().length === 1 && offered()[0] === 'auto')
  await cycle('auto')
  stdin.write('\x1b[C')
  await sleep(100) // 固定窗:探针 Cycling the only option must not introduce a different preference.
  assert.equal(stored, 'auto', 'only Auto remains selectable')
  channel.sessionRef = { backendId: 'other-backend', sessionId: 'session-a' }; emit()
  await wait(() => pending.length === 6, 'sessionRef backend change refreshes the catalog')
  channel.agentBindingGeneration++; emit()
  await wait(() => pending.length === 7, 'same session rebind invalidates pending catalog')
  pending[5]!.resolve({ efforts: [{ id: 'wrong-backend', name: 'Wrong backend' }], defaultEffort: undefined })
  pending[6]!.resolve({ efforts: [{ id: 'current', name: 'Current binding' }], defaultEffort: undefined })
  await settle(() => offered().includes('current'))
  assert.equal(offered().includes('wrong-backend'), false)
  channel.effortLevels = ['only-tier']; emit()
  await sleep(100) // 固定窗:探针 Semantically identical metadata must retain loaded choices.
  assert.equal(pending.length, 7, 'equal tiers with new projected identity do not refetch')
  assert.ok(offered().includes('current'))
  channel.effortLevels = ['current']; emit()
  await wait(() => pending.length === 8, 'changed capability tiers reload the same route')
  assert.deepEqual(offered(), ['auto'], 'loading cannot advertise the previous capability')
  pending[7]!.resolve({ efforts: [{ id: 'current', name: 'Refreshed label' }], defaultEffort: undefined })
  await settle(() => observedField?.options?.some(option => option.label === 'Refreshed label'))
  await cycle('current')
  await wait(() => has('Refreshed label'), 'same-route labels refresh through retained form')
  assert.equal(writes.some(value => ['off', 'low', 'high', 'max'].includes(value)), false, 'no fabricated static tiers')
} finally {
  await app.unmount()
  terminal.dispose()
  SettingsForm.prototype.field = originalField
  owner.dispose()
  lease.dispose()
}
console.log('PASS: dynamic effort catalog, persisted unknown value, stale/error/empty capability refresh')
