import type { CliOptions, Mode, ProgressEvent } from './define.ts'
import type { InputIssue, Next } from './errors.ts'
import { type Io, styler, writeAsync } from './io.ts'

/** Minimum interval between progress lines when no human is watching. */
export const PROGRESS_INTERVAL_MS = 15_000

/** A result object as written to stdout in machine mode. */
export type ResultObject = Record<string, unknown> & { ok: boolean }

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
  #pending: Promise<void>[] = []
  readonly #style: ReturnType<typeof styler>

  /** Creates a session for the resolved mode. */
  constructor(cli: CliOptions, io: Io, mode: Mode, debug: boolean) {
    this.cli = cli
    this.io = io
    this.mode = mode
    this.debug = debug
    this.#style = styler(io.stderr, mode.format === 'human' && !mode.agent)
  }

  /** `true` once the result has been written. */
  get rendered(): boolean {
    return this.#rendered
  }

  /** Writes a line to stderr, clearing any status line first. */
  log(message: string): void {
    this.#clearStatus()
    this.#pending.push(writeAsync(this.io.stderr, `${message}\n`))
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
      this.#pending.push(
        writeAsync(this.io.stderr, `\r\x1b[2K${this.#style('dim', text)}`)
      )
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
    await this.#flushStderr()
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
    this.#rendered = true
    const error = result.error as
      | { code: string; message: string; details?: unknown }
      | undefined
    const next = result.next as Next[] | undefined

    if (this.mode.format === 'json') {
      if (error) {
        this.log(`${this.cli.name}: ${error.message}`)
        if (extras.help && this.mode.agent) {
          this.log(extras.help)
        }
      }
      await this.#flushStderr()
      await writeAsync(this.io.stdout, `${JSON.stringify(result)}\n`)
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
      this.#clearStatus()
      await this.#flushStderr()
      await writeAsync(
        this.io.stdout,
        extras.human.endsWith('\n') ? extras.human : `${extras.human}\n`
      )
    }
    if (next?.length) {
      this.log(this.#formatNext(next))
    }
    await this.#flushStderr()
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
      this.#pending.push(writeAsync(this.io.stderr, '\r\x1b[2K'))
    }
  }

  /** Waits until earlier stderr writes are handed to the OS. */
  async #flushStderr(): Promise<void> {
    this.#clearStatus()
    const pending = this.#pending
    this.#pending = []
    await Promise.all(pending)
  }
}

/** Formats command data for human mode when the command has no formatter. */
export function formatData(data: Record<string, unknown>): string | undefined {
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
