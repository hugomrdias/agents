import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import type { CliError, Next } from './errors.ts'

/**
 * A schema that validates and exports JSON Schema, such as a zod v4 schema.
 *
 * @see https://standardschema.dev/json-schema
 */
export type Schema = StandardSchemaV1 & StandardJSONSchemaV1

/** Values accepted by an input schema; field names come from here. */
export type InputOf<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<S>
  : Record<string, never>

/** Values produced by an input schema after defaults and transforms. */
export type ParsedOf<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : Record<string, never>

/** Data a handler returns for an output schema, or any object without one. */
export type DataOf<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<S>
  : Record<string, unknown>

/** Names of an input schema's fields. */
export type FieldOf<S> = Extract<keyof InputOf<S>, string>

/** A module whose default export is created by {@link defineHandler}. */
export type HandlerLoader = () => Promise<unknown>

/** Properties accepted by {@link defineCommand}. */
export interface CommandOptions<
  I extends Schema | undefined,
  O extends Schema | undefined,
> {
  /** One word; the command's path is its group names plus this name. */
  name: string
  /** One line, used in help and `schema --list`. */
  description: string
  /** Runnable command lines, shown first in agent help. */
  examples?: string[]
  /** One object schema for everything the command accepts. */
  input?: I
  /** Input fields that may be given as positional arguments, in order. */
  positionals?: FieldOf<I>[]
  /** Environment variables used as fallbacks for input fields. */
  env?: { [K in FieldOf<I>]?: string }
  /** Fields read only from their environment variable and always redacted. */
  secrets?: FieldOf<I>[]
  /** Schema for the command fields of a successful result. */
  output?: O
  /** Error codes the command may return, besides the built-in codes. */
  errors?: string[]
  /** The command changes no state. Implies `idempotent`. */
  readOnly?: boolean
  /** Repeating the command with the same input has no additional effect. */
  idempotent?: boolean
  /** A reason to confirm, or a function of the input that returns one. */
  confirm?: string | ((input: ParsedOf<I>) => string | undefined)
  /** The command supports `--dry-run` through `ctx.dryRun`. */
  dryRun?: boolean
  /** Formats a successful result for human mode. */
  human?: (data: DataOf<O>) => string
  /** Lazily imports the module that default-exports the handler. */
  handler: HandlerLoader
}

/** A command definition created by {@link defineCommand}. */
export interface Command<
  I extends Schema | undefined = Schema | undefined,
  O extends Schema | undefined = Schema | undefined,
> extends CommandOptions<I, O> {
  readonly kind: 'command'
}

/** Any command definition, regardless of its schemas. */
// biome-ignore lint/suspicious/noExplicitAny: variance of handler types
export type AnyCommand = Command<any, any>

/** A named group of commands created by {@link defineGroup}. */
export interface Group {
  readonly kind: 'group'
  name: string
  description: string
  commands: CommandNode[]
}

/** An entry of a command tree. */
export type CommandNode = AnyCommand | Group

/** Options for a progress update. */
export interface ProgressEvent {
  phase: string
  message: string
  data?: Record<string, unknown>
}

/** A long-running job registered with `ctx.checkpoint`. */
export interface Checkpoint {
  id: string
  next?: Next[]
}

/** How the current invocation presents output. */
export interface Mode {
  /** `json` writes one result object to stdout; `human` writes text. */
  format: 'json' | 'human'
  /** Detected or forced agent name, or `false`. */
  agent: string | false
  /** A human can answer prompts. */
  interactive: boolean
}

const OK = Symbol.for('clipact.ok')

/** A successful handler result created by `ctx.ok`. */
export interface Ok<T> {
  readonly [OK]: true
  readonly data: T
  readonly next: Next[] | undefined
}

/** Returns `true` for a value created by `ctx.ok`. */
export function isOk(value: unknown): value is Ok<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && OK in value
}

/** Creates an {@link Ok} value. */
export function createOk<T>(data: T, next?: Next[]): Ok<T> {
  return { [OK]: true, data, next }
}

/** The context passed to a handler. */
export interface Context<
  I extends Schema | undefined,
  O extends Schema | undefined,
> {
  /** Validated input with defaults applied. */
  input: ParsedOf<I>
  /** Aborted on the first SIGINT, SIGTERM, or SIGHUP; pass it to all I/O. */
  signal: AbortSignal
  mode: Mode
  /** `--dry-run` was given; perform no side effects. */
  dryRun: boolean
  /** Reports progress on stderr: a status line for humans, periodic lines for agents. */
  progress(event: ProgressEvent): void
  /** Writes a human-readable line to stderr. */
  log(message: string): void
  /** Registers a long-running job; its ID is printed now and `next` is used if interrupted. */
  checkpoint(checkpoint: Checkpoint): void
  /** Creates the successful result. */
  ok(
    ...args: O extends Schema
      ? [data: DataOf<O>, options?: { next?: Next[] }]
      : [data?: Record<string, unknown>, options?: { next?: Next[] }]
  ): Ok<DataOf<O>>
}

const HANDLER = Symbol.for('clipact.handler')

/** A handler created by {@link defineHandler}. */
export interface Handler {
  readonly [HANDLER]: true
  // biome-ignore lint/suspicious/noExplicitAny: erased to keep definitions and handlers acyclic
  readonly run: (ctx: Context<any, any>) => Promise<Ok<unknown>>
}

/** Returns `true` for a value created by {@link defineHandler}. */
export function isHandler(value: unknown): value is Handler {
  return typeof value === 'object' && value !== null && HANDLER in value
}

/** Translates a third-party error into a {@link CliError}, or returns `undefined`. */
export type MapError = (
  error: unknown
) => CliError | undefined | Promise<CliError | undefined>

/** Options for {@link defineCli}. */
export interface CliOptions {
  /** The binary name, used in help and `next` commands. */
  name: string
  version: string
  description?: string
  /** Prefix of framework variables (`<PREFIX>_OUTPUT`, `<PREFIX>_AGENT`); defaults to the name. */
  envPrefix?: string
  commands: CommandNode[]
  /** Extra paths that resolve to a canonical command path, such as `{ publish: 'artifacts put' }`. */
  aliases?: Record<string, string>
  /** Lazily imports a module that default-exports a {@link MapError} function. */
  mapError?: () => Promise<{ default: MapError }>
}

/**
 * Defines a command. Handlers are loaded lazily, so this module should
 * import only the schema library.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/cli-framework-design.md#defining-commands
 */
export function defineCommand<
  I extends Schema | undefined = undefined,
  O extends Schema | undefined = undefined,
>(options: CommandOptions<I, O>): Command<I, O> {
  if (options.readOnly && options.confirm) {
    throw new TypeError(
      `Command "${options.name}" cannot be readOnly and require confirmation`
    )
  }
  for (const secret of options.secrets ?? []) {
    if (!options.env?.[secret]) {
      throw new TypeError(
        `Secret field "${secret}" of command "${options.name}" needs an env mapping`
      )
    }
  }
  return Object.freeze({ kind: 'command', ...options }) as Command<I, O>
}

/** Defines a group of commands, such as `artifacts` in `acme artifacts put`. */
export function defineGroup(options: Omit<Group, 'kind'>): Group {
  return Object.freeze({ kind: 'group', ...options })
}

/**
 * Defines the handler for a command; default-export the result from the
 * module that the command's `handler` loader imports.
 */
export function defineHandler<
  I extends Schema | undefined,
  O extends Schema | undefined,
>(
  _command: Command<I, O>,
  run: (ctx: Context<I, O>) => Promise<Ok<DataOf<O>>> | Ok<DataOf<O>>
): Handler {
  return {
    [HANDLER]: true,
    run: async (ctx) => await run(ctx),
  }
}
