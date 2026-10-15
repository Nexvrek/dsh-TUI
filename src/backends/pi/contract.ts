/**
 * Version contract of the pi backend (docs/pi-backend.md). There is no npm
 * dependency: the backend drives the user's own `pi` executable in RPC mode
 * (`pi --mode rpc`, JSONL over stdio). The protocol carries no version field
 * and no handshake, so the executable's `--version` is the only evidence.
 *
 * Version policy (the codex shape): a binary on the same minor line as a
 * validated version and not older than it is compatible; anything else on
 * or above {@link MIN_PI_VERSION} runs with a drift notice; below it the
 * backend reports itself not installed, with an upgrade hint.
 */

/** Backend id of the pi backend (`AgentSessionRef.backendId`). */
export const PI_BACKEND_ID = 'pi'

/** User-facing backend name. */
export const PI_BACKEND_LABEL = 'pi'

/** How a user re-enters a pi session from a shell through dsh-tui. */
export function piResumeCommand(sessionId: string): string {
  return `dsh-tui --backend pi --resume ${sessionId}`
}

/** The `pi` versions the backend is validated against. */
export const VALIDATED_PI_VERSIONS: readonly string[] = ['0.87.1']

/**
 * The oldest `pi` the backend starts on: every RPC command and event it
 * relies on is there by 0.84.4 (`get_entries` 0.80.3, `agent_settled`
 * 0.80.4, delta-only `message_update` 0.84.0, `toolcall_start` ids 0.84.3,
 * `clear_queue` 0.84.4). Later additions (`disposition` 0.99,
 * `agent_settled.aborted` 1.1) are read as optional.
 */
export const MIN_PI_VERSION = '0.84.4'

/** `X.Y.Z` (with an optional pre-release tail) from `pi --version`, else undefined. */
export function parsePiVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(text)?.[1]
}

/** Numeric `[major, minor, patch]` of a version, else undefined. */
function triple(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two versions by their numeric triple (pre-release tails ignored);
 *  undefined when either does not parse. */
export function comparePiVersions(a: string, b: string): number | undefined {
  const left = triple(a)
  const right = triple(b)
  if (left === undefined || right === undefined) return undefined
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return 0
}

/** Whether a version is at least {@link MIN_PI_VERSION} (an unreadable
 *  version is given the benefit of the doubt: drift, never a refusal). */
export function piVersionSupported(version: string | undefined): boolean {
  if (version === undefined) return true
  const order = comparePiVersions(version, MIN_PI_VERSION)
  return order === undefined || order >= 0
}

/** The version when it is outside the validated range, else undefined. */
export function piVersionDrift(version: string | undefined): string | undefined {
  if (version === undefined || version === '') return undefined
  const own = triple(version)
  if (own === undefined) return version
  const compatible = VALIDATED_PI_VERSIONS.some(validated => {
    const line = triple(validated)
    return line !== undefined && line[0] === own[0] && line[1] === own[1] && own[2] >= line[2]
  })
  return compatible ? undefined : version
}
