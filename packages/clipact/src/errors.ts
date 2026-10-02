/**
 * A follow-up step for the agent or the user.
 *
 * A step with `by: 'user'` is the action-required signal: the agent should
 * stop and relay it to a human.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#errors-next-steps-and-retries
 */
export interface Next {
  by: 'agent' | 'user'
  description: string
  command?: string
}

/** Machine-readable error body of a failed result. */
export interface ErrorBody {
  code: string
  message: string
  retryable: boolean
  retryAfterSeconds?: number
  details?: unknown
}

/** One problem with a command's input, as reported in `invalid_input` details. */
export interface InputIssue {
  path: string
  message: string
  source?: string
}

/** Error codes every command may return. */
export const BUILTIN_ERROR_CODES = [
  'invalid_input',
  'confirmation_required',
  'interrupted',
  'internal_error',
  'rate_limited',
  'service_unavailable',
  'timeout',
] as const

/** Codes whose `retryable` defaults to `true` for read-only or idempotent commands. */
export const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'service_unavailable',
  'timeout',
])

/** Options for {@link CliError}. */
export interface CliErrorOptions {
  code: string
  message: string
  /** Defaults by code and command side effects; see the design doc. */
  retryable?: boolean
  retryAfterSeconds?: number
  details?: unknown
  next?: Next[]
  /** Partial command output to include beside the error. */
  data?: Record<string, unknown>
  cause?: unknown
}

/**
 * An expected failure with a stable code, rendered as an `ok: false` result.
 */
export class CliError extends Error {
  readonly code: string
  readonly retryable: boolean | undefined
  readonly retryAfterSeconds: number | undefined
  readonly details: unknown
  readonly next: Next[] | undefined
  readonly data: Record<string, unknown> | undefined

  /** Creates an error from its result fields. */
  constructor(options: CliErrorOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'CliError'
    this.code = options.code
    this.retryable = options.retryable
    this.retryAfterSeconds = options.retryAfterSeconds
    this.details = options.details
    this.next = options.next
    this.data = options.data
  }
}

/** Returns `true` for a {@link CliError}, including instances from another copy of the module. */
export function isCliError(value: unknown): value is CliError {
  return (
    value instanceof CliError ||
    (value instanceof Error &&
      value.name === 'CliError' &&
      typeof (value as { code?: unknown }).code === 'string')
  )
}

/**
 * Thrown for a mistake in command definitions; rendered as `internal_error`.
 */
export class DefinitionError extends Error {
  /** Creates an error naming the faulty command. */
  constructor(command: string, message: string) {
    super(`Invalid definition for "${command}": ${message}`)
    this.name = 'DefinitionError'
  }
}
