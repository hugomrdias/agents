import type { CliOptions, Mode, ProgressEvent } from './define.ts'
import type { ErrorBody, InputIssue, Next } from './errors.ts'
import { type Io, styler, writeAsync } from './io.ts'

/** Minimum interval between progress lines when no human is watching. */
export const PROGRESS_INTERVAL_MS = 15_000

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
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli/guidelines.md#result-envelope
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
  #lastProgress = 0
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
  }

  /**
   * Shows progress: a rewritten status line on a human terminal, otherwise a
   * plain line at most every {@link PROGRESS_INTERVAL_MS}.
   */
  progress(event: ProgressEvent): void {
    const text = `${event.phase}: ${event.message}`
    if (
      this.mode.format === 'human' &&
      !this.mode.agent &&
      this.io.stderr.isTTY
    ) {
      this.#stderr(`${CLEAR_LINE}${this.#style('dim', text)}`)
      this.#statusLine = true
      return
    }
    const now = Date.now()
    if (now - this.#lastProgress >= PROGRESS_INTERVAL_MS) {
      this.#lastProgress = now
      this.log(`${this.cli.name}: ${text}`)
    }
  }

  /** Writes plain text to stdout, such as help or the version. */
  async text(text: string): Promise<void> {
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
