import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Env, identifyAgent, isSet } from './agent.ts'
import {
  type CliOptions,
  defineHandler,
  type Handler,
  type Mode,
  type TelemetryEvent,
  type TelemetryStatus,
} from './define.ts'
import { CliError } from './errors.ts'
import { detectProvider } from './provider.ts'
import { FRAMEWORK_FLAGS } from './route.ts'
import type { Session } from './session.ts'
import type { CommandSpec } from './spec.ts'
import {
  TELEMETRY_CONTEXT,
  type TelemetryCommand,
  type TelemetryContext,
} from './telemetry.ts'

/** The variable that carries the event to the sender process. */
export const EVENT_VARIABLE = 'CLIPACT_TELEMETRY_EVENT'

/** How long the sender process may run before it exits. */
export const SENDER_TIMEOUT_MS = 10_000

/** The framework state file's content. */
export interface State {
  /** The choice saved by `telemetry enable` or `telemetry disable`. */
  telemetry?: 'enabled' | 'disabled'
  /** The first-run notice was shown. */
  notice?: boolean
  installId?: string
}

/** The telemetry status of one invocation, with what reporting needs. */
export interface ResolvedTelemetry {
  status: TelemetryStatus
  /** `<PREFIX>_TELEMETRY=log`: print events to stderr instead of sending them. */
  log: boolean
  /** The state file, or `undefined` when there is no state directory. */
  file: string | undefined
  /** The state read from `file`; empty when it is missing or unreadable. */
  state: State
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Returns the CLI's state file in the platform state directory, or
 * `undefined` when the environment names no home directory.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#runtime-services
 */
export function stateFile(
  name: string,
  env: Env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  let directory: string | undefined
  if (platform === 'win32') {
    directory = env.LOCALAPPDATA && join(env.LOCALAPPDATA, name)
  } else if (platform === 'darwin') {
    directory =
      env.HOME && join(env.HOME, 'Library', 'Application Support', name)
  } else if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) {
    directory = join(env.XDG_STATE_HOME, name)
  } else {
    directory = env.HOME && join(env.HOME, '.local', 'state', name)
  }
  return directory ? join(directory, 'state.json') : undefined
}

/** Reads the state file, keeping only valid fields; returns `{}` on any failure. */
export async function readState(file: string): Promise<State> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }
    const { telemetry, notice, installId } = value as Record<string, unknown>
    return {
      ...(telemetry === 'enabled' || telemetry === 'disabled'
        ? { telemetry }
        : {}),
      ...(notice === true ? { notice } : {}),
      ...(typeof installId === 'string' && UUID.test(installId)
        ? { installId }
        : {}),
    }
  } catch {
    return {}
  }
}

/** Writes the state file through a temporary file, creating its directory. */
export async function writeState(file: string, state: State): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporary, file)
}

/**
 * Decides whether telemetry is on. Any opt-out wins: `DO_NOT_TRACK`, then
 * `<PREFIX>_TELEMETRY=0`, then the saved `disable`. Then `<PREFIX>_TELEMETRY=1`
 * or `log`, the saved `enable`, and the CLI's default. Without a `telemetry`
 * option, it reads only the environment opt-outs and never the state file.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#opting-out
 */
export async function resolveTelemetry(
  cli: CliOptions,
  envPrefix: string,
  env: Env,
  platform: NodeJS.Platform = process.platform
): Promise<ResolvedTelemetry> {
  const variable = `${envPrefix}_TELEMETRY`
  const raw = env[variable]
  const optOut = isSet(env.DO_NOT_TRACK)
    ? 'DO_NOT_TRACK'
    : raw === '0' || raw === 'false'
      ? variable
      : undefined
  if (!cli.telemetry) {
    return {
      status: {
        enabled: false,
        optedOut: optOut !== undefined,
        source: 'unconfigured',
        ...(optOut ? { variable: optOut } : {}),
      },
      log: false,
      file: undefined,
      state: {},
    }
  }
  const file = stateFile(cli.name, env, platform)
  const state = file ? await readState(file) : {}
  const resolved = (status: TelemetryStatus, log = false) => ({
    status,
    log,
    file,
    state,
  })
  if (optOut) {
    return resolved({
      enabled: false,
      optedOut: true,
      source: 'env',
      variable: optOut,
    })
  }
  if (state.telemetry === 'disabled') {
    return resolved({ enabled: false, optedOut: true, source: 'config' })
  }
  if (raw === '1' || raw === 'true' || raw === 'log') {
    return resolved(
      { enabled: true, optedOut: false, source: 'env', variable },
      raw === 'log'
    )
  }
  if (state.telemetry === 'enabled') {
    return resolved({ enabled: true, optedOut: false, source: 'config' })
  }
  return resolved({
    enabled: (cli.telemetry.default ?? 'on') === 'on',
    optedOut: false,
    source: 'default',
  })
}

/**
 * Returns the names of known flags typed before `--`, sorted and without
 * values. Unknown names are dropped, because a typo may hold a value.
 */
export function flagNames(
  args: string[],
  spec: CommandSpec | undefined
): string[] {
  const known = new Set<string>()
  const shorts = new Map<string, string>()
  for (const flag of FRAMEWORK_FLAGS) {
    known.add(flag.name)
    if (flag.negatable) {
      known.add(`no-${flag.name}`)
    }
    if (flag.short) {
      shorts.set(flag.short, flag.name)
    }
  }
  for (const field of spec?.fields ?? []) {
    known.add(field.flag)
    known.add(`no-${field.flag}`)
  }
  const names = new Set<string>()
  for (const arg of args) {
    if (arg === '--') {
      break
    }
    const name = arg.startsWith('--')
      ? arg.slice(2).split('=')[0]
      : /^-[A-Za-z]$/.test(arg)
        ? shorts.get(arg.slice(1))
        : undefined
    if (name && known.has(name)) {
      names.add(name)
    }
  }
  return [...names].sort()
}

/** What one invocation reports. */
export interface ReportInput {
  cli: CliOptions
  env: Env
  mode: Mode
  session: Session
  resolved: ResolvedTelemetry
  command: string
  flags: string[]
  errorCode: string | null
  durationMs: number
  /** Receives the event instead of the sender, such as in tests. */
  hook?: (event: TelemetryEvent) => void
}

/**
 * Reports one invocation after its result was written: shows the first-run
 * notice, saves the installation ID, and hands the event to the sender, or
 * prints it with `<PREFIX>_TELEMETRY=log`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#sending
 */
export async function report(input: ReportInput): Promise<void> {
  const { cli, env, session, resolved } = input
  const telemetry = cli.telemetry
  if (!telemetry || !resolved.status.enabled) {
    return
  }
  if (!resolved.log && isSet(env.CODEX_SANDBOX_NETWORK_DISABLED)) {
    return
  }
  const installId = await persist(cli, resolved, session, isSet(env.CI))
  const event = buildEvent(input, installId)
  if (resolved.log || session.debug) {
    session.log(`${cli.name}: telemetry event ${JSON.stringify(event)}`)
  }
  if (!resolved.log) {
    if (input.hook) {
      input.hook(event)
    } else {
      await send(telemetry.sender, event, env, session)
    }
  }
  await session.flush()
}

/**
 * Shows the first-run notice and creates the installation ID, saving both.
 * A saved `enable` or `disable` counts as having seen the notice. Returns
 * the installation ID, or `null` in CI, whose home directory rarely
 * survives the job, and when it cannot be saved.
 */
async function persist(
  cli: CliOptions,
  resolved: ResolvedTelemetry,
  session: Session,
  ci: boolean
): Promise<string | null> {
  const { file, state } = resolved
  const updates: State = {}
  if (!state.notice && !state.telemetry) {
    session.log(notice(cli))
    updates.notice = true
  }
  if (!state.installId && !ci) {
    updates.installId = randomUUID()
  }
  if (!file) {
    return null
  }
  if (updates.notice || updates.installId) {
    try {
      await writeState(file, { ...state, ...updates })
      Object.assign(state, updates)
    } catch (error) {
      if (session.debug) {
        session.log(
          `debug: cannot save ${file}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
  return ci ? null : (state.installId ?? null)
}

/** The one-line first-run notice, printed to stderr in every mode. */
function notice(cli: CliOptions): string {
  const docs = cli.telemetry?.docs ? ` Details: ${cli.telemetry.docs}` : ''
  return `${cli.name}: this CLI sends usage data (command and flag names, error codes, versions; never values). Turn it off with "${cli.name} telemetry disable" or DO_NOT_TRACK=1.${docs}`
}

/** Builds the event from names and outcomes only. */
function buildEvent(
  input: ReportInput,
  installId: string | null
): TelemetryEvent {
  const { cli, env, mode } = input
  const agent = mode.agent || null
  const detected = identifyAgent(env)
  return {
    eventVersion: 1,
    cli: { name: cli.name, version: cli.version },
    command: input.command,
    flags: input.flags,
    errorCode: input.errorCode,
    timestamp: new Date().toISOString(),
    durationMs: input.durationMs,
    env: {
      node: process.versions.node,
      os: process.platform,
      arch: process.arch,
      mode: isSet(env.CI)
        ? 'ci'
        : mode.interactive
          ? 'interactive'
          : 'noninteractive',
      format: mode.format,
      provider: detectProvider(env) ?? null,
      agent,
      agentVersion:
        agent && detected?.agent === agent ? (detected.version ?? null) : null,
    },
    installId,
  }
}

/**
 * The sender process: it reads the event, imports the sender module named by
 * its first argument, and calls its default export. It is inline so a
 * bundled CLI needs no extra file from clipact.
 */
const SENDER_SOURCE = `
const event = JSON.parse(process.env.${EVENT_VARIABLE})
delete process.env.${EVENT_VARIABLE}
setTimeout(() => process.exit(1), ${SENDER_TIMEOUT_MS}).unref()
try {
  const { default: send } = await import(process.argv[1])
  await send(event, { signal: AbortSignal.timeout(${SENDER_TIMEOUT_MS}) })
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\\n')
  process.exitCode = 1
}
`

/**
 * Starts the sender in a detached, unref'd process, so sending never delays
 * the exit. With `--debug`, waits for it and prints its errors.
 */
async function send(
  sender: URL | string,
  event: TelemetryEvent,
  env: Env,
  session: Session
): Promise<void> {
  const href =
    typeof sender === 'string' && !sender.startsWith('file:')
      ? pathToFileURL(sender).href
      : String(sender)
  const args = ['--input-type=module', '-e', SENDER_SOURCE, href]
  const options = {
    env: { ...env, [EVENT_VARIABLE]: JSON.stringify(event) },
    windowsHide: true,
  }
  if (!session.debug) {
    const child = spawn(process.execPath, args, {
      ...options,
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => undefined)
    child.unref()
    return
  }
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      stderr += error.message
      resolve(1)
    })
    child.on('close', resolve)
  })
  if (code !== 0) {
    session.log(`debug: telemetry sender failed: ${stderr.trim()}`)
  }
}

/** Reads the invocation details that the framework puts on `ctx`. */
function telemetryContext(ctx: object): TelemetryContext {
  return (ctx as Record<symbol, TelemetryContext>)[
    TELEMETRY_CONTEXT
  ] as TelemetryContext
}

/** The `telemetry status` handler. */
export function statusHandler(command: TelemetryCommand): Handler {
  return defineHandler(command, async (ctx) => ctx.ok(await ctx.telemetry()))
}

/**
 * The `telemetry enable` and `telemetry disable` handler: saves the choice
 * and reports the resulting status, which an environment opt-out may still
 * override.
 */
export function saveHandler(
  cli: CliOptions,
  command: TelemetryCommand,
  choice: 'enabled' | 'disabled'
): Handler {
  return defineHandler(command, async (ctx) => {
    const { env, envPrefix } = telemetryContext(ctx)
    const file = stateFile(cli.name, env)
    if (!file) {
      throw new CliError({
        code: 'state_unwritable',
        message: `Cannot find a state directory: set ${process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME'}.`,
        retryable: false,
        details: {},
      })
    }
    try {
      await writeState(file, { ...(await readState(file)), telemetry: choice })
    } catch (error) {
      throw new CliError({
        code: 'state_unwritable',
        message: `Cannot write ${file}.`,
        retryable: false,
        details: { path: file },
        cause: error,
      })
    }
    const { status } = await resolveTelemetry(cli, envPrefix, env)
    return ctx.ok(status)
  })
}
