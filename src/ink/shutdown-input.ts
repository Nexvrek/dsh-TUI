/** A renderer-owned input lease retained until terminal cleanup has settled. */
export type ShutdownInput = {
  readonly stdout: NodeJS.WriteStream
  ownsInput: () => boolean
  drain: () => void
  release: () => void
}

const owners = new WeakMap<NodeJS.ReadStream, { revoke?: () => void }>()
const handles = new WeakMap<() => void, ShutdownInput>()

/** Claim the actual input; a later renderer automatically revokes the old lease. */
export function claimShutdownInput(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  drain: () => void,
  revoke?: () => void,
): ShutdownInput {
  const previous = owners.get(stdin)
  const token = { revoke }
  owners.set(stdin, token)
  // Revoke before latching the old renderer so its cleanup cannot touch ours.
  previous?.revoke?.()
  const ownsInput = () => owners.get(stdin) === token
  return {
    stdout,
    ownsInput,
    drain: () => { if (ownsInput() && stdin.isTTY && !stdin.destroyed) drain() },
    release: () => { if (owners.get(stdin) === token) owners.delete(stdin) },
  }
}

/** Preserve the lease even when a legacy wrapper retains only unmount(). */
export function registerShutdownInput(unmount: () => void, input: ShutdownInput): void {
  handles.set(unmount, input)
}

export function getShutdownInput(handle: { unmount: () => void } | undefined): ShutdownInput | undefined {
  return handle === undefined ? undefined : handles.get(handle.unmount)
}
