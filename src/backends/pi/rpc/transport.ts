/**
 * One `pi --mode rpc` child and its JSONL link (pi's docs/rpc.md, json.md).
 *
 * - Framing: strict JSONL — records end at LF (an optional CR before it is
 *   stripped). Node's `readline` would also split on U+2028/U+2029, which are
 *   legal inside JSON strings, so stdout is decoded as a UTF-8 stream and
 *   split here. Stdout is read continuously: a stalled reader stalls pi.
 * - Correlation: commands carry a string `id` echoed by their `response`.
 *   pi handles commands concurrently, so answers are matched by id, never by
 *   order. A response without a known id (a parse error) only goes to the
 *   debug log.
 * - Everything that is not a response is an event (`AgentSessionEvent`
 *   shapes plus `extension_ui_request`) and goes to the event listeners in
 *   arrival order.
 * - Exit: pending commands reject with the tail of the child's stderr (pi
 *   writes its startup failures there and exits 1: no model, a broken
 *   extension, a session cwd that is gone). Closing stdin is pi's orderly
 *   shutdown; `close()` escalates to signals only when that does not end it.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { errorText, rec, str, type Rec } from '../narrow.js'

/** One event record (anything on stdout that is not a response). */
export type PiRpcEvent = Rec & { readonly type: string }

/** A failed command (`success: false`), with pi's own message. */
export class PiRpcError extends Error {
  readonly command: string
  constructor(command: string, message: string) {
    super(message)
    this.name = 'PiRpcError'
    this.command = command
  }
}

/** The child ended (or never started); `stderr` is the tail it wrote. */
export class PiExitError extends Error {
  readonly code: number | null
  readonly signal: string | null
  readonly stderr: readonly string[]
  constructor(message: string, code: number | null, signal: string | null, stderr: readonly string[]) {
    super(message)
    this.name = 'PiExitError'
    this.code = code
    this.signal = signal
    this.stderr = stderr
  }
}

export interface PiExitInfo {
  readonly code: number | null
  readonly signal: string | null
  readonly stderr: readonly string[]
  /** `close()` asked for it (an orderly shutdown, not a crash). */
  readonly requested: boolean
}

export interface PiRpcLink {
  /** Send a command and wait for its response's `data` (undefined when the
   *  response has none). Rejects with {@link PiRpcError} on `success: false`,
   *  {@link PiExitError} when the child is gone, or a timeout error. */
  request(type: string, params?: Rec, options?: { readonly timeoutMs?: number }): Promise<unknown>
  /** Write one record that expects no response (`extension_ui_response`). */
  send(record: Rec): void
  onEvent(listener: (event: PiRpcEvent) => void): () => void
  onExit(listener: (info: PiExitInfo) => void): () => void
  readonly exited: boolean
  readonly pid: number | undefined
  /** The child's last stderr lines (diagnostics). */
  stderrTail(): readonly string[]
  /** Orderly shutdown: close stdin, then SIGTERM, then SIGKILL. Idempotent. */
  close(options?: { readonly graceMs?: number }): Promise<void>
}

export interface PiRpcSpawnOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** One stderr line (never the terminal: the host logs and folds it). */
  readonly stderr?: (line: string) => void
  readonly debug?: (message: string) => void
  /** Test seam: the process spawner. */
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
}

/** Default bound for a command's answer (prompt/compact/abort pass their own). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const STDERR_TAIL = 40
const MAX_LINE_CHARS = 64 * 1024 * 1024

/** Split decoded stdout into complete records (pure; the transport's framer). */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = ''
  return {
    push(chunk: string): void {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
        index = buffer.indexOf('\n')
      }
      // A record that never ends is a broken stream, not a long message.
      if (buffer.length > MAX_LINE_CHARS) buffer = ''
    },
    flush(): void {
      if (buffer !== '') onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
      buffer = ''
    },
  }
}

/** Spawn `pi` with `args` (which must include `--mode rpc`) and link to it. */
export function spawnPiRpc(options: PiRpcSpawnOptions): PiRpcLink {
  const debug = options.debug ?? (() => undefined)
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions))
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
  })
  const pending = new Map<string, { readonly resolve: (data: unknown) => void; readonly reject: (error: Error) => void; readonly command: string; timer?: ReturnType<typeof setTimeout> }>()
  const eventListeners = new Set<(event: PiRpcEvent) => void>()
  const exitListeners = new Set<(info: PiExitInfo) => void>()
  const stderrLines: string[] = []
  let exited = false
  let closeRequested = false
  let exitInfo: PiExitInfo | undefined
  let seq = 0

  const failAll = (error: Error): void => {
    for (const [id, entry] of pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(error)
    }
  }

  const onRecord = (line: string): void => {
    if (line.trim() === '') return
    let record: Rec | undefined
    try {
      record = rec(JSON.parse(line))
    } catch {
      debug(`pi: non-JSON stdout line (${line.length} chars)`)
      return
    }
    if (record === undefined) return
    const type = str(record.type)
    if (type === undefined) return
    if (type === 'response') {
      const id = str(record.id)
      const entry = id === undefined ? undefined : pending.get(id)
      if (entry === undefined) {
        if (record.success === false) debug(`pi: unmatched error response (${str(record.command) ?? '?'}: ${str(record.error) ?? ''})`)
        return
      }
      pending.delete(id!)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      if (record.success === true) entry.resolve(record.data)
      else entry.reject(new PiRpcError(entry.command, str(record.error) ?? `pi ${entry.command} failed`))
      return
    }
    const event = record as PiRpcEvent
    for (const listener of [...eventListeners]) {
      try {
        listener(event)
      } catch (error) {
        debug(`pi: event listener failed (${errorText(error)})`)
      }
    }
  }

  const stdout = createLineSplitter(onRecord)
  const decoder = new StringDecoder('utf8')
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(decoder.write(chunk)) })
  child.stdout.on('end', () => { stdout.push(decoder.end()); stdout.flush() })

  const stderr = createLineSplitter(line => {
    if (line.trim() === '') return
    stderrLines.push(line)
    if (stderrLines.length > STDERR_TAIL) stderrLines.shift()
    options.stderr?.(line)
  })
  const stderrDecoder = new StringDecoder('utf8')
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(stderrDecoder.write(chunk)) })
  child.stderr.on('end', () => { stderr.push(stderrDecoder.end()); stderr.flush() })

  // A write after the child died raises EPIPE on stdin; the exit path reports it.
  child.stdin.on('error', error => { debug(`pi: stdin error (${errorText(error)})`) })

  const finish = (code: number | null, signal: string | null, spawnError?: Error): void => {
    if (exited) return
    exited = true
    exitInfo = { code, signal, stderr: [...stderrLines], requested: closeRequested }
    const tail = stderrLines.slice(-6).join('\n')
    const reason = spawnError !== undefined ? spawnError.message : `pi exited (${signal ?? `code ${code ?? '?'}`})`
    failAll(new PiExitError(tail === '' ? reason : `${reason}\n${tail}`, code, signal, [...stderrLines]))
    for (const listener of [...exitListeners]) {
      try {
        listener(exitInfo)
      } catch (error) {
        debug(`pi: exit listener failed (${errorText(error)})`)
      }
    }
  }
  child.on('exit', (code, signal) => {
    // Let the last stdout/stderr bytes land before pending commands fail.
    setImmediate(() => finish(code, signal))
  })
  child.on('error', error => { finish(null, null, error) })

  const writeLine = (record: Rec): void => {
    if (exited || child.stdin.destroyed || !child.stdin.writable) throw new PiExitError('pi is not running', exitInfo?.code ?? null, exitInfo?.signal ?? null, [...stderrLines])
    child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  let closePromise: Promise<void> | undefined

  return {
    request(type, params = {}, requestOptions = {}) {
      return new Promise((resolve, reject) => {
        const id = `dsh-${++seq}`
        const timeoutMs = requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        const entry: { resolve: (data: unknown) => void; reject: (error: Error) => void; command: string; timer?: ReturnType<typeof setTimeout> } = { resolve, reject, command: type }
        if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
          entry.timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`pi did not answer ${type} within ${Math.round(timeoutMs / 1000)}s`))
          }, timeoutMs)
          entry.timer.unref?.()
        }
        pending.set(id, entry)
        try {
          writeLine({ ...params, id, type })
        } catch (error) {
          pending.delete(id)
          if (entry.timer !== undefined) clearTimeout(entry.timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    send(record) {
      writeLine(record)
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => { eventListeners.delete(listener) }
    },
    onExit(listener) {
      if (exited && exitInfo !== undefined) {
        const info = exitInfo
        queueMicrotask(() => listener(info))
        return () => undefined
      }
      exitListeners.add(listener)
      return () => { exitListeners.delete(listener) }
    },
    get exited() { return exited },
    get pid() { return child.pid },
    stderrTail: () => [...stderrLines],
    close(closeOptions = {}) {
      if (closePromise !== undefined) return closePromise
      closeRequested = true
      closePromise = new Promise<void>(resolve => {
        if (exited) { resolve(); return }
        const grace = closeOptions.graceMs ?? 3000
        const timers: ReturnType<typeof setTimeout>[] = []
        const done = (): void => {
          for (const timer of timers) clearTimeout(timer)
          resolve()
        }
        exitListeners.add(() => done())
        try { child.stdin.end() } catch { /* already closed */ }
        timers.push(setTimeout(() => {
          if (exited) return
          try { child.kill('SIGTERM') } catch { /* gone */ }
          timers.push(setTimeout(() => {
            if (exited) return
            try { child.kill('SIGKILL') } catch { /* gone */ }
            // A child that ignores even SIGKILL (or whose exit never fires)
            // must not hold the exit funnel.
            timers.push(setTimeout(done, 1000))
          }, 2000))
        }, grace))
      })
      return closePromise
    },
  }
}
