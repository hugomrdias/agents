import {
  COMPLETE_COMMAND,
  complete,
  completionHelp,
  completionScript,
  isShell,
  SHELLS,
} from './completion.ts'
import {
  type AnyCommand,
  type Checkpoint,
  type CliOptions,
  type Context,
  createOk,
  type Group,
  isBuiltin,
  isHandler,
  isOk,
  type Mode,
  type Schema,
} from './define.ts'
import { schemaCommand } from './discovery.ts'
import {
  CliError,
  DefinitionError,
  type InputIssue,
  isCliError,
  TRANSIENT_ERROR_CODES,
} from './errors.ts'
import { commandHelp, groupHelp, leaves, usage } from './help.ts'
import { type FrameworkValues, invalidInput, resolveInput } from './input.ts'
import { type Io, processIo } from './io.ts'
import { resolveMode } from './mode.ts'
import {
  FRAMEWORK_FLAGS,
  frameworkToken,
  type GlobalFlags,
  route,
  scanGlobalFlags,
  unknownCommand,
} from './route.ts'
import {
  formatData,
  type RenderExtras,
  type ResultObject,
  Session,
} from './session.ts'
import { skillsGroup, skillsPath } from './skills.ts'
import { type CommandSpec, resolveSpec } from './spec.ts'

/** Signals that cancel the running command. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** Keys of the result envelope that command data may not use. */
const RESERVED_KEYS = ['ok', 'error', 'next']

/** Global flags that built-in commands ignore; each built-in decides about `--help`. */
const BUILTIN_IGNORED_FLAGS = FRAMEWORK_FLAGS.filter(
  (flag) => flag.global && flag.name !== 'help'
)

/** The outcome of a command that printed text, such as help. */
const TEXT_OUTCOME: Outcome = {
  exitCode: 0,
  result: undefined,
  signal: undefined,
}

/** The outcome of one invocation. */
export interface Outcome {
  exitCode: 0 | 1
  /** The result object, also written to stdout in machine mode. */
  result: ResultObject | undefined
  /** The signal to re-raise after an interruption. */
  signal: NodeJS.Signals | undefined
}

/** Options for {@link Cli.execute}. */
export interface ExecuteOptions {
  /** Aborted to interrupt the command, with the signal name as the reason. */
  signal?: AbortSignal
  /** Rejects with an uncaught error, which then becomes `internal_error`. */
  crash?: Promise<never>
  /** Checks results against output schemas and declared error codes. */
  strict?: boolean
}

/** A CLI created by {@link defineCli}. */
export interface Cli {
  readonly options: CliOptions
  /** The root group of the command tree, including the `skills` group. */
  readonly root: Group
  /** Framework variable prefix, such as `ACME`. */
  readonly envPrefix: string
  /** Runs with the real process: installs signal and crash handlers and sets the exit code. */
  run(argv?: string[]): Promise<void>
  /** Runs one invocation against the given streams without touching the process. */
  execute(args: string[], io: Io, options?: ExecuteOptions): Promise<Outcome>
}

/**
 * Defines a CLI from its command tree.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/cli-framework-design.md
 */
export function defineCli(definition: CliOptions): Cli {
  const defines = (name: string) =>
    definition.commands.some((node) => node.name === name)
  const commands = [...definition.commands]
  const options: CliOptions = { ...definition, commands }
  const root: Group = {
    kind: 'group',
    name: options.name,
    description: options.description ?? '',
    commands,
  }
  if (definition.skills && !defines('skills')) {
    commands.push(skillsGroup(definition, definition.skills))
  }
  if (!defines('schema')) {
    commands.push(schemaCommand(options, root))
  }
  const envPrefix = (options.envPrefix ?? options.name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')

  const execute = async (
    args: string[],
    io: Io,
    executeOptions: ExecuteOptions = {}
  ): Promise<Outcome> => {
    const controller = new AbortController()
    const signal = executeOptions.signal
      ? AbortSignal.any([controller.signal, executeOptions.signal])
      : controller.signal
    const flags = scanGlobalFlags(args)
    const { mode, issues: modeIssues } = resolveMode(flags, io, envPrefix)
    const session = new Session(options, io, mode, flags.debug)
    const invocation = new Invocation({
      cli: options,
      root,
      args,
      io,
      mode,
      modeIssues,
      flags,
      session,
      controller,
      signal,
      strict: executeOptions.strict === true,
    })
    const work = invocation.run()
    try {
      return await (executeOptions.crash
        ? Promise.race([work, executeOptions.crash])
        : work)
    } catch (error) {
      const outcome = await invocation.fail(error)
      // Stop handler I/O that would otherwise keep the process alive.
      controller.abort(error)
      return outcome
    }
  }

  return {
    options,
    root,
    envPrefix,
    execute,
    async run(argv = process.argv) {
      const controller = new AbortController()
      const onSignal = (signal: NodeJS.Signals) => controller.abort(signal)
      for (const signal of SIGNALS) {
        process.once(signal, onSignal)
      }
      process.stdout.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
          process.exit(0)
        }
        throw error
      })
      let finished = false
      const { promise: crash, reject: reportCrash } =
        Promise.withResolvers<never>()
      crash.catch(() => undefined)
      const onCrash = (error: unknown) => {
        if (finished) {
          process.stderr.write(
            `${options.name}: internal error after the result: ${String(error)}\n`
          )
          process.exitCode = 1
        } else {
          reportCrash(error)
        }
      }
      process.on('uncaughtException', onCrash)
      process.on('unhandledRejection', onCrash)

      const outcome = await execute(argv.slice(2), processIo(), {
        signal: controller.signal,
        crash,
      })
      finished = true
      process.exitCode = outcome.exitCode
      for (const signal of SIGNALS) {
        process.off(signal, onSignal)
      }
      if (outcome.signal) {
        process.kill(process.pid, outcome.signal)
      }
    },
  }
}

/** State shared by the steps of one invocation. */
interface InvocationState {
  cli: CliOptions
  root: Group
  args: string[]
  io: Io
  mode: Mode
  modeIssues: InputIssue[]
  flags: GlobalFlags
  session: Session
  /** Aborted with a signal name. */
  controller: AbortController
  /** Aborted by `controller` or the caller's signal. */
  signal: AbortSignal
  strict: boolean
}

/** Runs the execution pipeline for one argv. */
class Invocation {
  readonly #state: InvocationState
  #spec: CommandSpec | undefined
  #checkpoint: Checkpoint | undefined
  /** Agent help for the group a routing error happened in. */
  #groupHelp: string | undefined

  /** Creates an invocation. */
  constructor(state: InvocationState) {
    this.#state = state
  }

  /** Routes, parses, validates, gates, runs, and renders. */
  async run(): Promise<Outcome> {
    const { cli, root, args, flags, mode } = this.#state
    try {
      if (args[0] === COMPLETE_COMMAND) {
        return await this.#text(complete(cli, root, args.slice(1)))
      }
      const routed = route(root, args, cli.aliases)
      if (flags.version) {
        return await this.#text(`${cli.version}\n`)
      }
      if (routed.kind === 'unknown') {
        this.#groupHelp = groupHelp(cli, routed.group, routed.path, true)
        throw unknownCommand(cli, routed)
      }
      if (routed.kind === 'builtin') {
        return await this.#completion(routed.rest)
      }
      const { node, path } = routed
      if (node.kind === 'group') {
        if (flags.help || mode.format === 'human') {
          return await this.#text(
            groupHelp(cli, node, path, Boolean(mode.agent))
          )
        }
        this.#groupHelp = groupHelp(cli, node, path, true)
        throw missingCommand(cli, node, path)
      }
      const spec = resolveSpec(node, path.join(' '))
      this.#spec = spec
      if (flags.help) {
        return await this.#text(commandHelp(cli, spec, Boolean(mode.agent)))
      }
      // Built-ins print the same JSON in every mode, so they ignore mode issues.
      if (this.#state.modeIssues.length > 0 && !isBuiltin(node)) {
        throw invalidInput(this.#state.modeIssues)
      }
      const outcome = await this.#command(spec, routed.rest)
      if (!isBuiltin(node)) {
        await this.#skillsNotice(path)
      }
      return outcome
    } catch (error) {
      return await this.fail(error)
    }
  }

  /** Converts any thrown value into an error result and renders it. */
  async fail(error: unknown): Promise<Outcome> {
    const { session, signal, cli } = this.#state
    const command = this.#spec?.command
    if (
      signal.aborted &&
      typeof signal.reason === 'string' &&
      signal.reason.startsWith('SIG')
    ) {
      return await this.#interrupted(signal.reason as NodeJS.Signals)
    }
    let cliError: CliError | undefined
    if (isCliError(error)) {
      cliError = error
    } else if (!(error instanceof DefinitionError) && cli.mapError) {
      try {
        const { default: mapError } = await cli.mapError()
        cliError = await mapError(error)
      } catch (mapFailure) {
        error = mapFailure
      }
    }
    if (!cliError) {
      if (session.debug && error instanceof Error && error.stack) {
        session.log(error.stack)
      }
      cliError = new CliError({
        code: 'internal_error',
        message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        next: [
          {
            by: 'user',
            description: `Report this problem with the output of the same command run with --debug`,
          },
        ],
      })
    }
    const result = errorResult(cliError, command)
    const extras: RenderExtras = {}
    if (cliError.code === 'invalid_input') {
      const spec = this.#spec
      extras.usage = spec && usage(cli, spec)
      extras.help = spec ? commandHelp(cli, spec, true) : this.#groupHelp
    }
    return await this.#finish(this.#checked(result, cliError.data), extras)
  }

  /** Handles the built-in `completion` command. */
  async #completion(rest: string[]): Promise<Outcome> {
    const { cli, mode, flags } = this.#state
    const words = builtinWords(rest, 'completion', ['--help', '-h'])
    if (flags.help || (words.length === 0 && mode.format === 'human')) {
      return await this.#text(completionHelp(cli.name))
    }
    const shell = words[0]
    if (words.length !== 1 || !isShell(shell)) {
      throw new CliError({
        code: 'invalid_input',
        message: `Expected one shell: ${SHELLS.join(', ')}.`,
        details: [
          {
            path: 'shell',
            source: 'positional',
            message: `Expected one of ${SHELLS.join(', ')}`,
          },
        ],
        next: [
          {
            by: 'user',
            command: `${cli.name} completion --help`,
            description: 'Show how to install completions',
          },
        ],
      })
    }
    return await this.#text(completionScript(cli.name, shell))
  }

  /** Writes text such as help to stdout and returns a successful outcome. */
  async #text(text: string): Promise<Outcome> {
    await this.#state.session.text(text)
    return TEXT_OUTCOME
  }

  /** Validates input, applies the confirmation gate, and runs the handler. */
  async #command(spec: CommandSpec, rest: string[]): Promise<Outcome> {
    const { cli, io, session, signal, mode } = this.#state
    const { command } = spec
    const {
      value: input,
      sources,
      framework,
    } = await resolveInput(spec, rest, io, signal)
    if (session.debug) {
      session.log(describeSources(spec, input, sources))
    }
    await this.#confirm(command, input, framework)
    if (signal.aborted) {
      throw signal.reason
    }

    const module = await command.handler()
    const handler = (module as { default?: unknown } | undefined)?.default
    if (!isHandler(handler)) {
      throw new DefinitionError(
        spec.path,
        'the handler module must default-export defineHandler(...)'
      )
    }
    const context: Context<undefined, undefined> = {
      input: input as Record<string, never>,
      signal,
      mode,
      dryRun: framework.dryRun,
      progress: (event) => session.progress(event),
      log: (message) => session.log(message),
      checkpoint: (checkpoint) => {
        this.#checkpoint = checkpoint
        const resume = checkpoint.next?.find((step) => step.command)?.command
        session.log(
          `${cli.name}: started ${checkpoint.id}${resume ? `; if interrupted, run: ${resume}` : ''}`
        )
      },
      ok: (data, options) => createOk(data ?? {}, options?.next),
    }
    const value = await handler.run(context)
    if (!isOk(value)) {
      throw new DefinitionError(
        spec.path,
        'the handler must return ctx.ok(...)'
      )
    }
    const data = value.data
    let checked = this.#checked(
      {
        ok: true,
        ...withoutReserved(data),
        ...(value.next?.length ? { next: value.next } : {}),
      },
      data
    )
    const output: Schema | undefined = command.output
    if (this.#state.strict && output && checked.ok) {
      const validation = await output['~standard'].validate(data)
      if (validation.issues) {
        checked = contractViolation(
          `output does not match the schema: ${validation.issues.map((issue) => issue.message).join('; ')}`
        )
      }
    }
    const human = command.human ?? formatData
    return await this.#finish(checked, {
      human: checked.ok ? human(data) : undefined,
    })
  }

  /** After a human-mode command, suggests updating project skills installed by another version. */
  async #skillsNotice(path: string[]): Promise<void> {
    const { cli, mode, session } = this.#state
    if (
      !cli.skills ||
      mode.format !== 'human' ||
      mode.agent ||
      path[0] === 'skills'
    ) {
      return
    }
    try {
      const { staleNotice } = await import('./skills.run.ts')
      const notice = await staleNotice(cli, skillsPath(cli.skills))
      if (notice) {
        session.log(notice)
        await session.flush()
      }
    } catch {
      // A notice never changes the outcome.
    }
  }

  /** Requires confirmation from a human or `--yes` when the command asks for it. */
  async #confirm(
    command: AnyCommand,
    input: Record<string, unknown>,
    framework: FrameworkValues
  ): Promise<void> {
    const { cli, args, io, mode, signal } = this.#state
    const reason =
      typeof command.confirm === 'function'
        ? command.confirm(input)
        : command.confirm
    if (!reason || framework.yes || framework.dryRun) {
      return
    }
    if (mode.interactive) {
      // Loaded on use, so other invocations never pay for node:readline.
      const { createInterface } = process.getBuiltinModule(
        'node:readline/promises'
      )
      const readline = createInterface({
        input: io.stdin,
        output: io.stderr as NodeJS.WritableStream,
      })
      readline.on('SIGINT', () => this.#state.controller.abort('SIGINT'))
      try {
        const answer = await readline.question(`${reason} Continue? [y/N] `, {
          signal,
        })
        if (/^y(es)?$/i.test(answer.trim())) {
          return
        }
      } finally {
        readline.close()
      }
      throw new CliError({
        code: 'confirmation_required',
        message: 'Confirmation declined.',
        retryable: false,
        details: { reason },
      })
    }
    throw new CliError({
      code: 'confirmation_required',
      message: `${reason} Confirm with --yes.`,
      retryable: false,
      details: { reason },
      next: [
        {
          by: 'user',
          command: rerunWithYes(cli.name, args),
          description: 'Approve this action, then run it with --yes',
        },
      ],
    })
  }

  /** Renders the interrupted result for a signal. */
  async #interrupted(signalName: NodeJS.Signals): Promise<Outcome> {
    const result = errorResult(
      new CliError({
        code: 'interrupted',
        message: `Interrupted by ${signalName}.`,
        retryable: this.#spec?.command.idempotent === true,
        next: this.#checkpoint?.next,
      }),
      undefined
    )
    const outcome = await this.#finish(result, {})
    return { ...outcome, signal: signalName }
  }

  /** In strict mode, replaces a result that breaks the command's contract. */
  #checked(result: ResultObject, data?: Record<string, unknown>): ResultObject {
    if (!this.#state.strict) {
      return result
    }
    const spec = this.#spec
    if (data) {
      const reserved = RESERVED_KEYS.filter((key) => key in data)
      if (reserved.length > 0) {
        return contractViolation(
          `output uses reserved keys: ${reserved.join(', ')}`
        )
      }
    }
    const { error } = result
    if (error && spec) {
      if (!spec.errors.includes(error.code)) {
        return contractViolation(
          `error code "${error.code}" is not declared in errors`
        )
      }
      if (error.retryable && !spec.command.idempotent) {
        return contractViolation(
          `"${error.code}" is retryable but the command is neither readOnly nor idempotent`
        )
      }
    }
    return result
  }

  /** Renders a result and returns the outcome. */
  async #finish(result: ResultObject, extras: RenderExtras): Promise<Outcome> {
    await this.#state.session.render(result, extras)
    return { exitCode: result.ok ? 0 : 1, result, signal: undefined }
  }
}

/** Builds an error result, applying the default `retryable` rules; data cannot override reserved keys. */
function errorResult(
  error: CliError,
  command: AnyCommand | undefined
): ResultObject {
  const retryable =
    error.retryable ??
    (TRANSIENT_ERROR_CODES.has(error.code) && command?.idempotent === true)
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    ...withoutReserved(error.data ?? {}),
    ...(error.next?.length ? { next: error.next } : {}),
  }
}

/** Returns command data without the envelope's reserved keys. */
function withoutReserved(
  data: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !RESERVED_KEYS.includes(key))
  )
}

/** Builds the `internal_error` result for a broken command contract in strict mode. */
function contractViolation(message: string): ResultObject {
  return errorResult(
    new CliError({
      code: 'internal_error',
      message: `Contract violation: ${message}.`,
      retryable: false,
    }),
    undefined
  )
}

/** Builds the error for a group invoked without a subcommand in machine mode. */
function missingCommand(
  cli: CliOptions,
  group: Group,
  path: string[]
): CliError {
  const commands = leaves(group, path).map((leaf) => leaf.path)
  return new CliError({
    code: 'invalid_input',
    message: `Missing command after "${[cli.name, ...path].join(' ')}".`,
    retryable: false,
    details: { commands },
    next: [
      {
        by: 'agent',
        command: `${cli.name} schema --list`,
        description: 'List all commands with descriptions',
      },
    ],
  })
}

/**
 * Returns the words given to a built-in command, skipping framework flags
 * and rejecting flags the built-in does not accept.
 */
function builtinWords(
  rest: string[],
  name: string,
  accepted: string[]
): string[] {
  const words: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string
    const token = frameworkToken(arg, BUILTIN_IGNORED_FLAGS)
    if (token === 'value') {
      index++ // its value was read by the mode resolution
      continue
    }
    if (token || accepted.includes(arg)) {
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliError({
        code: 'invalid_input',
        message: `Unknown flag ${arg} for ${name}.`,
        details: [{ path: arg, source: 'flag', message: 'Unknown flag' }],
      })
    }
    words.push(arg)
  }
  return words
}

/** Lists each input value and its source for `--debug`, redacting secrets. */
function describeSources(
  spec: CommandSpec,
  input: Record<string, unknown>,
  sources: Record<string, string>
): string {
  const lines = spec.fields
    .filter((field) => field.name in sources)
    .map((field) => {
      const value = field.secret
        ? '<redacted>'
        : JSON.stringify(input[field.name])
      return `  ${field.name} = ${value} (${sources[field.name]})`
    })
  return `debug: input for ${spec.path}\n${lines.join('\n')}`
}

/** Quotes an argument for POSIX shells when needed. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** Returns the same command line with `--yes` added before any `--`. */
function rerunWithYes(name: string, args: string[]): string {
  const terminator = args.indexOf('--')
  const withYes =
    terminator === -1
      ? [...args, '--yes']
      : [...args.slice(0, terminator), '--yes', ...args.slice(terminator)]
  return [name, ...withYes].map(quote).join(' ')
}
