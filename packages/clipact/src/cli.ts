import { createInterface } from 'node:readline/promises'
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
  isHandler,
  isOk,
  type Mode,
  type Schema,
} from './define.ts'
import { commandSchema, listSchema } from './discovery.ts'
import {
  BUILTIN_ERROR_CODES,
  CliError,
  DefinitionError,
  type InputIssue,
  isCliError,
  type Next,
  TRANSIENT_ERROR_CODES,
} from './errors.ts'
import { commandHelp, groupHelp, leaves, usage } from './help.ts'
import { type FrameworkValues, resolveInput } from './input.ts'
import { type Io, processIo } from './io.ts'
import { resolveMode } from './mode.ts'
import {
  closest,
  findNode,
  type Route,
  route,
  scanGlobalFlags,
} from './route.ts'
import {
  formatData,
  type RenderExtras,
  type ResultObject,
  Session,
} from './session.ts'
import { type CommandSpec, resolveSpec } from './spec.ts'

/** Signals that cancel the running command. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** Keys of the result envelope that command data may not use. */
const RESERVED_KEYS = ['ok', 'error', 'next']

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
export function defineCli(options: CliOptions): Cli {
  const root: Group = {
    kind: 'group',
    name: options.name,
    description: options.description ?? '',
    commands: options.commands,
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
    const external = executeOptions.signal
    if (external?.aborted) {
      controller.abort(external.reason)
    }
    external?.addEventListener(
      'abort',
      () => controller.abort(external.reason),
      {
        once: true,
      }
    )
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
      signal: controller.signal,
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
      let reportCrash: (error: unknown) => void = () => undefined
      const crash = new Promise<never>((_resolve, reject) => {
        reportCrash = reject
      })
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
  flags: ReturnType<typeof scanGlobalFlags>
  session: Session
  /** Aborted with a signal name; linked to the caller's signal. */
  controller: AbortController
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
    const { cli, root, args, flags, session, mode } = this.#state
    try {
      if (args[0] === COMPLETE_COMMAND) {
        await session.text(complete(cli, root, args.slice(1)))
        return { exitCode: 0, result: undefined, signal: undefined }
      }
      const routed = route(root, args, cli.aliases)
      if (flags.version) {
        await session.text(`${cli.version}\n`)
        return { exitCode: 0, result: undefined, signal: undefined }
      }
      if (routed.kind === 'unknown') {
        this.#groupHelp = groupHelp(cli, routed.group, routed.path, true)
        throw unknownCommand(cli, routed)
      }
      if (routed.kind === 'builtin') {
        return routed.name === 'schema'
          ? await this.#schema(routed.consumed)
          : await this.#completion(routed.consumed)
      }
      const { node, path } = routed
      if (node.kind === 'group') {
        if (flags.help || mode.format === 'human') {
          await session.text(groupHelp(cli, node, path, Boolean(mode.agent)))
          return { exitCode: 0, result: undefined, signal: undefined }
        }
        this.#groupHelp = groupHelp(cli, node, path, true)
        throw missingCommand(cli, node, path)
      }
      const spec = resolveSpec(node, path.join(' '))
      this.#spec = spec
      if (flags.help) {
        await session.text(commandHelp(cli, spec, Boolean(mode.agent)))
        return { exitCode: 0, result: undefined, signal: undefined }
      }
      if (this.#state.modeIssues.length > 0) {
        throw new CliError({
          code: 'invalid_input',
          message: `${this.#state.modeIssues[0]?.path}: ${this.#state.modeIssues[0]?.message}.`,
          details: this.#state.modeIssues,
        })
      }
      return await this.#command(spec, routed.consumed)
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
    if (cliError.code === 'invalid_input' && this.#spec) {
      extras.usage = usage(cli, this.#spec)
      extras.help = commandHelp(cli, this.#spec, true)
    } else if (cliError.code === 'invalid_input') {
      extras.help = this.#groupHelp
    }
    return await this.#finish(this.#checked(result, cliError.data), extras)
  }

  /** Handles the built-in `schema` command. */
  async #schema(consumed: number[]): Promise<Outcome> {
    const { cli, root, args, session, mode } = this.#state
    const words = builtinWords(args, consumed, 'schema', ['--list'])
    const node = words.length > 0 ? findNode(root, words) : undefined
    if (words.length > 0 && !node) {
      throw unknownCommand(cli, {
        kind: 'unknown',
        group: root,
        path: [],
        word: words.join(' '),
        suggestion: closest(
          words.join(' '),
          leaves(root).map((leaf) => leaf.path)
        ),
      })
    }
    const result =
      node?.kind === 'command'
        ? commandSchema(cli, resolveSpec(node, words.join(' ')))
        : listSchema(cli, node, words)
    if (mode.format === 'human') {
      await session.text(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      await session.text(`${JSON.stringify(result)}\n`)
    }
    return {
      exitCode: 0,
      result: result as ResultObject,
      signal: undefined,
    }
  }

  /** Handles the built-in `completion` command. */
  async #completion(consumed: number[]): Promise<Outcome> {
    const { cli, args, session, mode, flags } = this.#state
    const words = builtinWords(args, consumed, 'completion', ['--help', '-h'])
    if (flags.help || (words.length === 0 && mode.format === 'human')) {
      await session.text(completionHelp(cli.name))
      return { exitCode: 0, result: undefined, signal: undefined }
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
    await session.text(completionScript(cli.name, shell))
    return { exitCode: 0, result: undefined, signal: undefined }
  }

  /** Validates input, applies the confirmation gate, and runs the handler. */
  async #command(spec: CommandSpec, consumed: number[]): Promise<Outcome> {
    const { cli, args, io, session, signal, mode } = this.#state
    const { command } = spec
    const rest = args.filter((_, index) => !consumed.includes(index))
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
    const { ok: _ok, error: _error, next: _next, ...fields } = data
    let checked = this.#checked(
      {
        ok: true,
        ...fields,
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
    return await this.#finish(checked, {
      human: checked.ok
        ? command.human
          ? command.human(data)
          : formatData(data)
        : undefined,
    })
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
    const command = this.#spec?.command
    const next = this.#checkpoint?.next
    const result: ResultObject = {
      ok: false,
      error: {
        code: 'interrupted',
        message: `Interrupted by ${signalName}.`,
        retryable: Boolean(command?.readOnly || command?.idempotent),
      },
      ...(next?.length ? { next } : {}),
    }
    const outcome = await this.#finish(result, {})
    return { ...outcome, signal: signalName }
  }

  /** In strict mode, replaces a result that breaks the command's contract. */
  #checked(result: ResultObject, data?: Record<string, unknown>): ResultObject {
    if (!this.#state.strict) {
      return result
    }
    const command = this.#spec?.command
    if (data) {
      const reserved = RESERVED_KEYS.filter((key) => key in data)
      if (reserved.length > 0) {
        return contractViolation(
          `output uses reserved keys: ${reserved.join(', ')}`
        )
      }
    }
    const error = result.error as
      | { code: string; retryable: boolean }
      | undefined
    if (error && command) {
      const known = [...(command.errors ?? []), ...BUILTIN_ERROR_CODES]
      if (!known.includes(error.code)) {
        return contractViolation(
          `error code "${error.code}" is not declared in errors`
        )
      }
      if (error.retryable && !(command.readOnly || command.idempotent)) {
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
    (TRANSIENT_ERROR_CODES.has(error.code) &&
      Boolean(command?.readOnly || command?.idempotent))
  const { ok: _ok, error: _error, next: _next, ...data } = error.data ?? {}
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
    ...data,
    ...(error.next?.length ? { next: error.next } : {}),
  }
}

/** Builds the `internal_error` result for a broken command contract in strict mode. */
function contractViolation(message: string): ResultObject {
  return {
    ok: false,
    error: {
      code: 'internal_error',
      message: `Contract violation: ${message}.`,
      retryable: false,
    },
  }
}

/** Builds the error for an unknown command word. */
function unknownCommand(
  cli: CliOptions,
  routed: Extract<Route, { kind: 'unknown' }>
): CliError {
  const attempted = [cli.name, ...routed.path, routed.word].join(' ')
  const next: Next[] = []
  if (routed.suggestion) {
    next.push({
      by: 'agent',
      command: [cli.name, ...routed.path, routed.suggestion, '--help'].join(
        ' '
      ),
      description: `Show help for "${routed.suggestion}"`,
    })
  }
  next.push({
    by: 'agent',
    command: `${cli.name} schema --list`,
    description: 'List all commands',
  })
  return new CliError({
    code: 'invalid_input',
    message: `Unknown command "${attempted}".${routed.suggestion ? ` Did you mean "${routed.suggestion}"?` : ''}`,
    retryable: false,
    next,
  })
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
  args: string[],
  consumed: number[],
  name: string,
  accepted: string[]
): string[] {
  const rest = args.filter((_, index) => !consumed.includes(index))
  const words: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string
    if (arg === '--format') {
      index++ // its value was read by the mode resolution
      continue
    }
    if (accepted.includes(arg) || isFrameworkToken(arg)) {
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

/** Returns `true` for framework flags that built-in commands ignore. */
function isFrameworkToken(arg: string): boolean {
  return (
    ['--json', '--agent', '--no-agent', '--debug'].includes(arg) ||
    arg.startsWith('--format=')
  )
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
