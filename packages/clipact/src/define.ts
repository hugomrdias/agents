import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import type { CliError, ErrorRegistry, Next } from './errors.ts'

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
  /** Schema of `data` in a successful result: an object or an array. */
  output?: O
  /** Codes from the CLI's error registry the command may return, besides the built-in codes. */
  errors?: string[]
  /** The command changes no state. Implies `idempotent`. */
  readOnly?: boolean
  /** Repeating the command with the same input has no additional effect; set by `readOnly`. */
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
export function isOk(value: unknown): value is Ok<unknown> {
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
  /**
   * Reports a change on stderr: a status line for humans, a line per event for
   * agents. clipact repeats the latest event while the command stays quiet.
   */
  progress(event: ProgressEvent): void
  /** Writes a human-readable line to stderr. */
  log(message: string): void
  /** Registers a long-running job; its ID is printed now and `next` is used if interrupted. */
  checkpoint(checkpoint: Checkpoint): void
  /**
   * Resolves whether the framework sends telemetry and whether the user opted
   * out. Check `optedOut` before the application's own reporting, such as an
   * agent header on API requests. Never change output or behavior based on it.
   *
   * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#runtime-services
   */
  telemetry(): Promise<TelemetryStatus>
  /** Creates the successful result; `data` defaults to `{}`. */
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

/**
 * Whether telemetry is on, as reported by `telemetry status` and
 * `ctx.telemetry()`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#opting-out
 */
export interface TelemetryStatus {
  /** The framework sends an event for this run. */
  enabled: boolean
  /** `DO_NOT_TRACK`, `<PREFIX>_TELEMETRY=0`, or `telemetry disable` turned telemetry off. */
  optedOut: boolean
  /** What decided `enabled`; `unconfigured` when the CLI has no `telemetry` option. */
  source: 'env' | 'config' | 'default' | 'unconfigured'
  /** The environment variable behind the answer, if any. */
  variable?: string
}

/**
 * One telemetry event: names and outcomes only, never argument values,
 * paths, or messages.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#what-to-collect
 */
export interface TelemetryEvent {
  /** Version of this event's shape. */
  eventVersion: 1
  /** The CLI's `name` and `version`. */
  cli: { name: string; version: string }
  /** Command path, such as `artifacts put`; empty for the root. */
  command: string
  /** Names of known flags typed on the command line, sorted, without values. */
  flags: string[]
  /** The error code of a failed command; `null` on success. */
  errorCode: string | null
  /** When the result was written, as an ISO 8601 string. */
  timestamp: string
  /** Milliseconds from the start of the run until the result was written. */
  durationMs: number
  /** Where and how the command ran. */
  env: TelemetryEnv
  /** Random ID stored in the state file; `null` in CI and when it cannot be saved. */
  installId: string | null
}

/** The `env` block of a {@link TelemetryEvent}. */
export interface TelemetryEnv {
  /** Node.js version, such as `24.21.0`. */
  node: string
  os: string
  arch: string
  /** `ci` when `CI` is set, otherwise whether a human can answer prompts. */
  mode: 'interactive' | 'noninteractive' | 'ci'
  format: Mode['format']
  /** CI or deployment provider, such as `github_actions`. */
  provider: string | null
  /** Detected or forced agent name. */
  agent: string | null
  /** The agent's version, when `AI_AGENT` or `AGENT` carries one. */
  agentVersion: string | null
}

/**
 * The default export of a telemetry sender module. It runs in a detached
 * child process, so it may take its time; `signal` aborts after 10 seconds.
 */
export type TelemetrySender = (
  event: TelemetryEvent,
  options: { signal: AbortSignal }
) => void | Promise<void>

/**
 * Telemetry settings for {@link defineCli}.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#runtime-services
 */
export interface TelemetryOptions {
  /**
   * The module that default-exports a {@link TelemetrySender}, such as
   * `new URL('./telemetry.js', import.meta.url)`. It must exist as a file at
   * run time, so make it its own entry point when bundling.
   */
  sender: URL | string
  /** Whether telemetry is on before the user chooses; defaults to `on`. */
  default?: 'on' | 'off'
  /** A page that lists the collected fields, linked from the first-run notice. */
  docs?: string
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
  /**
   * Directory of bundled skills (`<name>/SKILL.md`), such as
   * `new URL('../skills/', import.meta.url)`; adds the `skills` commands.
   *
   * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#agent-skills
   */
  skills?: URL | string
  /** Lazily imports a module that default-exports a {@link MapError} function. */
  mapError?: () => Promise<{ default: MapError }>
  /**
   * Every error code the commands may return besides the built-in codes,
   * with a description and an optional `details` schema.
   *
   * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#errors-next-steps-and-retries
   */
  errors?: ErrorRegistry
  /**
   * Sends usage events after each command and adds the `telemetry` commands.
   *
   * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#telemetry
   */
  telemetry?: TelemetryOptions
}

/**
 * Defines a command. Handlers are loaded lazily, so this module should
 * import only the schema library.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#defining-commands
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
  return Object.freeze({
    kind: 'command',
    ...options,
    // readOnly implies idempotent; consumers read only `idempotent`.
    idempotent: options.readOnly === true || options.idempotent === true,
  }) as Command<I, O>
}

/** Options for {@link markBuiltin}. */
interface BuiltinOptions {
  /**
   * A successful result prints the command's `human` text in every mode
   * instead of a JSON result, such as a shell script read by `eval`.
   */
  plainText?: boolean
  /**
   * The input field whose positional words are a command path, such as
   * `schema <group> <command>`; completion offers command names for it.
   */
  commandPath?: string
}

/** Framework commands routed like any other but kept out of command lists. */
const BUILTIN_NODES = new WeakMap<CommandNode, BuiltinOptions>()

/**
 * Marks a framework-owned command as built-in: it is listed under "Built-in"
 * in root help instead of with the application's commands.
 */
export function markBuiltin<T extends CommandNode>(
  node: T,
  options: BuiltinOptions = {}
): T {
  BUILTIN_NODES.set(node, options)
  return node
}

/** Returns `true` for a command marked with {@link markBuiltin}. */
export function isBuiltin(node: CommandNode): boolean {
  return BUILTIN_NODES.has(node)
}

/** A leaf command with its full path. */
export interface Leaf {
  path: string
  command: AnyCommand
}

/** Lists every command below `node` with its path, depth first, skipping built-ins. */
export function leaves(node: CommandNode, prefix: string[] = []): Leaf[] {
  if (node.kind === 'command') {
    return [{ path: prefix.join(' '), command: node }]
  }
  return node.commands
    .filter((child) => !isBuiltin(child))
    .flatMap((child) => leaves(child, [...prefix, child.name]))
}

/** Returns `true` for a built-in whose successful result is plain text. */
export function printsPlainText(node: CommandNode): boolean {
  return BUILTIN_NODES.get(node)?.plainText === true
}

/** Returns the input field of a built-in whose positionals are a command path. */
export function commandPathField(node: CommandNode): string | undefined {
  return BUILTIN_NODES.get(node)?.commandPath
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
