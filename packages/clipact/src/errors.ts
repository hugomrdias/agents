import type { Schema } from './define.ts'
import { fromJsonSchema } from './json-schema.ts'

/**
 * A follow-up step for the agent or the user.
 *
 * A step with `by: 'user'` is the action-required signal: the agent should
 * stop and relay it to a human.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli/guidelines.md#errors-next-steps-and-retries
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

/**
 * One entry of the CLI's error registry: what a code means and, when its
 * `details` has a fixed shape, the schema of `details`.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli/guidelines.md#errors-next-steps-and-retries
 */
export interface ErrorDefinition {
  /** One sentence, published by `schema <command>`. */
  description: string
  /** Schema of `error.details`, checked in strict mode. */
  details?: Schema
}

/** Error codes mapped to their definitions. */
export type ErrorRegistry = Record<string, ErrorDefinition>

/** `details` of `invalid_input`: every problem with the input. */
const inputIssues = fromJsonSchema<InputIssue[]>({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      message: { type: 'string' },
      source: { type: 'string' },
    },
    required: ['path', 'message'],
    additionalProperties: false,
  },
})

/** `details` of `confirmation_required`: why the command asks. */
const confirmationReason = fromJsonSchema<{ reason: string }>({
  type: 'object',
  properties: { reason: { type: 'string' } },
  required: ['reason'],
  additionalProperties: false,
})

/** Error codes every command may return, with their definitions. */
export const BUILTIN_ERRORS: Readonly<ErrorRegistry> = Object.freeze({
  invalid_input: {
    description:
      'The arguments, flags, --input JSON, or environment variables are invalid.',
    details: inputIssues,
  },
  confirmation_required: {
    description:
      'The command needs confirmation; a human approves it and runs it with --yes.',
    details: confirmationReason,
  },
  interrupted: {
    description:
      'A signal stopped the command; follow the next steps to inspect or resume it.',
  },
  internal_error: {
    description: 'An unexpected failure in the CLI; report it.',
  },
  rate_limited: {
    description: 'A service limited the request rate.',
  },
  service_unavailable: {
    description: 'A service the command depends on is unavailable.',
  },
  timeout: {
    description: 'A request took too long.',
  },
})

/** Error codes every command may return. */
export const BUILTIN_ERROR_CODES: readonly string[] = Object.freeze(
  Object.keys(BUILTIN_ERRORS)
)

/** Error codes of the framework's `skills` commands, registered when they are installed. */
export const SKILLS_ERRORS: Readonly<ErrorRegistry> = Object.freeze({
  skill_conflict: {
    description:
      'Installed skill directories have local changes, are symbolic links, or were not installed by this CLI.',
    details: fromJsonSchema({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          target: { type: 'string', enum: ['agents', 'claude'] },
          path: { type: 'string' },
          reason: { type: 'string', enum: ['edited', 'unmanaged', 'symlink'] },
          files: { type: 'array', items: { type: 'string' } },
          resolvesTo: { type: 'string' },
        },
        required: ['name', 'target', 'path', 'reason'],
        additionalProperties: false,
      },
    }),
  },
})

/**
 * Returns a CLI's full error registry: the framework's codes and its own.
 * Throws a `TypeError` when the CLI redefines a framework code.
 *
 * @param own - The CLI's `errors` option.
 * @param skills - Whether the framework's `skills` commands are installed.
 */
export function errorRegistry(
  own: ErrorRegistry | undefined,
  skills: boolean
): Readonly<ErrorRegistry> {
  const framework = { ...BUILTIN_ERRORS, ...(skills ? SKILLS_ERRORS : {}) }
  for (const code of Object.keys(own ?? {})) {
    if (code in framework) {
      throw new TypeError(
        `Error code "${code}" is built in and cannot be redefined`
      )
    }
  }
  return Object.freeze({ ...framework, ...own })
}

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
  cause?: unknown
}

/**
 * An expected failure with a stable code, rendered as an `error` result.
 */
export class CliError extends Error {
  readonly code: string
  readonly retryable: boolean | undefined
  readonly retryAfterSeconds: number | undefined
  readonly details: unknown
  readonly next: Next[] | undefined

  /** Creates an error from its result fields. */
  constructor(options: CliErrorOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'CliError'
    this.code = options.code
    this.retryable = options.retryable
    this.retryAfterSeconds = options.retryAfterSeconds
    this.details = options.details
    this.next = options.next
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
