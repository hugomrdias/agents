import type { CliOptions, Mode, ProgressEvent } from './define.ts'
import type { ErrorBody, InputIssue, Next } from './errors.ts'
import { type Io, styler, writeAsync } from './io.ts'

/**
 * Quiet time on stderr after which the latest progress event is repeated
 * with its elapsed time, so agent harnesses see the command is alive.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#output-size-and-long-running-commands
 */
export const HEARTBEAT_FIRST_MS = 15_000

/** Interval between later heartbeats while the same event stays current. */
export const HEARTBEAT_MS = 30_000

/** Returns the cursor to the line start and erases the line. */
const CLEAR_LINE = '\r\x1b[2K'

/** The result of a successful command. */
export interface DataResult {
  data: unknown
  next?: Next[]
}

/** The result of a failed command. */
export interface ErrorResult {
  error: ErrorBody
  next?: Next[]
}

/**
 * A result object as written to stdout in machine mode: exactly one of
 * `data` and `error`, then optional `next` steps.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#result-envelope
 */
export type ResultObject = DataResult | ErrorResult

/** Returns `true` for the result of a failed command. */
export function isErrorResult(result: ResultObject): result is ErrorResult {
  return 'error' in result
}

/** What to print besides the result in human mode or on a usage error. */
export interface RenderExtras {
  /** Human-mode text for a successful result. */
  human?: string
  /** Usage line printed on a usage error in human mode. */
  usage?: string
  /** Full help printed to stderr on a usage error in agent mode. */
  help?: string
  /** Help for a group run without a command, printed to stderr before the error in human mode. */
  groupHelp?: string
}

/**
 * Owns the streams for one invocation: stderr diagnostics and progress, and
 * the single final write of the result.
 */
export class Session {
  readonly cli: CliOptions
  readonly io: Io
  readonly mode: Mode
  readonly debug: boolean
  #rendered = false
  #statusLine = false
  /** The latest progress event, when it started, and heartbeats since. */
  #current: { event: ProgressEvent; since: number; beats: number } | undefined
  #heartbeat: ReturnType<typeof setTimeout> | undefined
  /** The latest stderr write; writes to one stream complete in order. */
  #pending: Promise<void> = Promise.resolve()
  readonly #style: ReturnType<typeof styler>

  /** Creates a session for the resolved mode. */
  constructor(cli: CliOptions, io: Io, mode: Mode, debug: boolean) {
    this.cli = cli
    this.io = io
    this.mode = mode
    this.debug = debug
    this.#style = styler(io.stderr, mode.format === 'human' && !mode.agent)
  }

  /** Writes a line to stderr, clearing any status line first. */
  log(message: string): void {
    this.#clearStatus()
    this.#stderr(`${message}\n`)
    this.#arm()
  }

  /**
   * Shows progress: a rewritten status line on a human terminal, otherwise a
   * plain line for every event. After {@link HEARTBEAT_FIRST_MS} of quiet,
   * and then every {@link HEARTBEAT_MS}, it repeats the latest event with
   * its elapsed time, so handlers report each change once and never re-emit.
   *
   * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#output-size-and-long-running-commands
   */
  progress(event: ProgressEvent): void {
    this.#current = { event, since: Date.now(), beats: 0 }
    this.#showProgress(event, '')
  }

  /** Stops heartbeats; called once the result is about to be written. */
  stop(): void {
    clearTimeout(this.#heartbeat)
    this.#heartbeat = undefined
    this.#current = undefined
  }

  /** Writes plain text to stdout, such as help or the version. */
  async text(text: string): Promise<void> {
    this.stop()
    this.#rendered = true
    await this.flush()
    await writeAsync(this.io.stdout, text)
  }

  /**
   * Writes the result once: one JSON line in machine mode, or text in human
   * mode with errors and next steps on stderr.
   */
  async render(result: ResultObject, extras: RenderExtras = {}): Promise<void> {
    if (this.#rendered) {
      return
    }
    this.stop()
    // Serialize first: if it throws, the error result can still be rendered.
    const json =
      this.mode.format === 'json' ? `${JSON.stringify(result)}\n` : undefined
    this.#rendered = true
    const error = isErrorResult(result) ? result.error : undefined
    const { next } = result

    if (json !== undefined) {
      if (error) {
        this.log(`${this.cli.name}: ${error.message}`)
        if (extras.help && this.mode.agent) {
          this.log(extras.help)
        }
      }
      await this.flush()
      await writeAsync(this.io.stdout, json)
      return
    }

    if (error) {
      if (extras.groupHelp) {
        this.log(extras.groupHelp)
      }
      const style = this.#style
      const lines = [
        `${style(['bold', 'red'], 'Error:')} ${error.message} ${style('dim', `(${error.code})`)}`,
      ]
      if (Array.isArray(error.details)) {
        for (const issue of error.details as InputIssue[]) {
          if (issue && typeof issue === 'object' && 'message' in issue) {
            const source = issue.source
              ? style('dim', ` (${issue.source})`)
              : ''
            lines.push(`  ${issue.path}${source}: ${issue.message}`)
          }
        }
      }
      if (extras.usage) {
        lines.push(`Usage: ${extras.usage}`)
      }
      this.log(lines.join('\n'))
    } else if (extras.human) {
      await this.flush()
      await writeAsync(
        this.io.stdout,
        extras.human.endsWith('\n') ? extras.human : `${extras.human}\n`
      )
    }
    if (next?.length) {
      this.log(this.#formatNext(next))
    }
    await this.flush()
  }

  /** Clears any status line and waits until earlier stderr writes are handed to the OS. */
  async flush(): Promise<void> {
    this.#clearStatus()
    await this.#pending
  }

  /** Formats next steps for humans. */
  #formatNext(next: Next[]): string {
    const style = this.#style
    const lines = next.map((step) => {
      const who = step.by === 'user' ? style('yellow', 'You: ') : ''
      const command = step.command ? `\n    ${style('cyan', step.command)}` : ''
      return `  ${who}${step.description}${command}`
    })
    return `Next:\n${lines.join('\n')}`
  }

  /** Writes a progress event, with `suffix` such as the elapsed time. */
  #showProgress(event: ProgressEvent, suffix: string): void {
    const text = `${event.phase}: ${event.message}${suffix}`
    if (
      this.mode.format === 'human' &&
      !this.mode.agent &&
      this.io.stderr.isTTY
    ) {
      this.#stderr(`${CLEAR_LINE}${this.#style('dim', text)}`)
      this.#statusLine = true
      this.#arm()
      return
    }
    this.log(`${this.cli.name}: ${text}`)
  }

  /** Restarts the quiet timer after a stderr write, while an event is current. */
  #arm(): void {
    clearTimeout(this.#heartbeat)
    this.#heartbeat = undefined
    const current = this.#current
    if (!current || this.#rendered) return
    const delay = current.beats === 0 ? HEARTBEAT_FIRST_MS : HEARTBEAT_MS
    this.#heartbeat = setTimeout(() => {
      current.beats += 1
      this.#showProgress(
        current.event,
        ` (${formatElapsed(Date.now() - current.since)})`
      )
    }, delay)
    // A pending heartbeat never keeps the process alive.
    this.#heartbeat.unref?.()
  }

  /** Clears a human status line before other output. */
  #clearStatus(): void {
    if (this.#statusLine) {
      this.#statusLine = false
      this.#stderr(CLEAR_LINE)
    }
  }

  /** Queues a write to stderr. */
  #stderr(chunk: string): void {
    this.#pending = writeAsync(this.io.stderr, chunk)
  }
}

/** Formats an elapsed time as `45 s` or `2 min 5 s`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const rest = seconds % 60
  return `${Math.floor(seconds / 60)} min${rest ? ` ${rest} s` : ''}`
}

/** Formats command data for human mode when the command has no formatter. */
export function formatData(data: unknown): string | undefined {
  if (Array.isArray(data)) {
    return data.length > 0 ? JSON.stringify(data, null, 2) : undefined
  }
  if (data === null || typeof data !== 'object') {
    return data === undefined ? undefined : String(data)
  }
  const entries = Object.entries(data).filter(
    ([, value]) => value !== undefined
  )
  if (entries.length === 0) {
    return undefined
  }
  return entries
    .map(([key, value]) =>
      value !== null && typeof value === 'object'
        ? `${key}:\n${JSON.stringify(value, null, 2).replace(/^/gm, '  ')}`
        : `${key}: ${String(value)}`
    )
    .join('\n')
}
