/**
 * A fake `pi --mode rpc` child for the pi backend's session regressions: a
 * stand-in for `child_process.spawn` (the transport's `spawn` seam) whose
 * stdin records every command and whose stdout the test scripts. Commands
 * without a handler get a plain success response. Nothing is spawned.
 */
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

type Rec = Record<string, unknown>

export interface FakePi {
  /** The spawner to hand to `spawnPiRpc` / `openPiBackendSession`. */
  readonly spawn: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams
  /** Every record written to stdin, in order. */
  readonly received: Rec[]
  /** The arguments of the last spawn. */
  args: readonly string[]
  /** Answer commands of `type` (return the response `data`, or throw to fail it;
   *  return `undefined` and call `respond` yourself to answer later). */
  on(type: string, handler: (command: Rec) => unknown): void
  /** Write one stdout record (an event). */
  emit(record: Rec): void
  /** Write raw stdout text (framing tests). */
  write(text: string): void
  /** Answer a command later. */
  respond(command: Rec, data?: unknown, error?: string): void
  /** Write a stderr line. */
  stderr(line: string): void
  /** End the child as a crash (or an orderly exit). */
  exit(code: number | null, signal?: string | null): void
  /** Wait until a command of `type` arrives. */
  next(type: string): Promise<Rec>
  readonly exited: boolean
}

/** A record whose `type` is the given one (pending `response` excluded). */
export function createFakePi(options: { readonly exitOnStdinEnd?: boolean } = {}): FakePi {
  const handlers = new Map<string, (command: Rec) => unknown>()
  const received: Rec[] = []
  const waiters: { type: string; resolve: (command: Rec) => void }[] = []
  let child: (EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; pid: number; kill(signal?: string): boolean }) | undefined
  let exited = false
  let buffer = ''

  const fake: FakePi = {
    received,
    args: [],
    spawn(_command, args) {
      fake.args = args
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          buffer += chunk.toString('utf8')
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
            const command = JSON.parse(line) as Rec
            received.push(command)
            for (const waiter of [...waiters]) {
              if (waiter.type !== command.type) continue
              waiters.splice(waiters.indexOf(waiter), 1)
              waiter.resolve(command)
            }
            if (command.type === 'extension_ui_response') continue
            const handler = handlers.get(String(command.type))
            queueMicrotask(() => {
              if (exited) return
              if (handler === undefined) { fake.respond(command); return }
              try {
                const data = handler(command)
                if (data !== undefined) fake.respond(command, data === null ? undefined : data)
              } catch (error) {
                fake.respond(command, undefined, error instanceof Error ? error.message : String(error))
              }
            })
          }
          callback()
        },
        final(callback) {
          callback()
          if (options.exitOnStdinEnd !== false) setTimeout(() => fake.exit(0), 5)
        },
      })
      child = Object.assign(new EventEmitter(), {
        stdin, stdout, stderr, pid: 4242,
        kill: (signal?: string) => { fake.exit(null, signal ?? 'SIGTERM'); return true },
      })
      return child as unknown as ChildProcessWithoutNullStreams
    },
    on(type, handler) { handlers.set(type, handler) },
    emit(record) { fake.write(`${JSON.stringify(record)}\n`) },
    write(text) { if (!exited) child?.stdout.write(text) },
    respond(command, data, error) {
      fake.emit(error === undefined
        ? { id: command.id, type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) }
        : { id: command.id, type: 'response', command: command.type, success: false, error })
    },
    stderr(line) { child?.stderr.write(`${line}\n`) },
    exit(code, signal = null) {
      if (exited || child === undefined) return
      exited = true
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => child!.emit('exit', code, signal), 1)
    },
    next(type) {
      return new Promise(resolve => { waiters.push({ type, resolve }) })
    },
    get exited() { return exited },
  }
  return fake
}

/** The `get_state` answer of a fresh faux session. */
export function fakeState(overrides: Rec = {}): Rec {
  return {
    model: { provider: 'faux', id: 'faux-1', name: 'Faux One', contextWindow: 128_000, reasoning: true, input: ['text', 'image'] },
    thinkingLevel: 'medium', isStreaming: false, isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time',
    sessionId: 'fake-session', autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    ...overrides,
  }
}
