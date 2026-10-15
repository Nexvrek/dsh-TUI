/**
 * Static description of the pi backend (see `src/agent/backend-manifest.ts`
 * for the field semantics).
 *
 * Pure data, zero imports beyond the type: the build-time index imports this
 * module statically on every boot, DSH-only ones included.
 *
 * The codex shape (§6 item 12 of the backend contribution note): this backend
 * drives the user's own `pi` executable (`pi --mode rpc`) and imports no
 * vendor package, so `vendorPackages` is empty and `install` is absent —
 * detection's own "how to get it" hint is what the row owes a user. There is
 * no process-wide pool either (one child per session, owned by
 * `session.dispose()`), hence no `unloadExport`. No `nativeKey`: sessions
 * write `native: {}`.
 */
import type { BackendManifest } from '../../agent/backend-manifest.js'

export const manifest: BackendManifest = {
  id: 'pi',
  label: { kind: 'key', key: 'kernel-label-pi' },
  shortLabel: 'pi',
  product: 'pi',
  inTree: true,
  backendExport: 'piBackend',
  vendorPackages: [],
  // The optional session surfaces `session/session.ts` serves.
  capabilities: [
    'native', 'questions', 'models', 'effort', 'compact', 'commands', 'images',
    'context', 'rename', 'color', 'diagnostics', 'fork', 'rewind',
  ],
  grants: [],
}
