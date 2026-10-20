import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type Env, identifyAgent, isSet } from './agent.ts'
import {
  type CliOptions,
  defineHandler,
  type Handler,
  type Mode,
  type TelemetryEvent,
  type TelemetryStatus,
} from './define.ts'
import { frameworkVariables } from './mode.ts'
import { detectProvider } from './provider.ts'
import { FRAMEWORK_FLAGS } from './route.ts'
import type { Session } from './session.ts'
import type { CommandSpec } from './spec.ts'
import { CLIPACT_FILE, ensureDir, noDir, unwritable } from './storage.ts'
import { type TelemetryCommand, telemetryContexts } from './telemetry.ts'

/** The variable that carries the event to the sender process. */
export const EVENT_VARIABLE = 'CLIPACT_TELEMETRY_EVENT'

/** How long the sender process may run before it exits. */
export const SENDER_TIMEOUT_MS = 10_000

/** The content of `clipact.json`, clipact's own file in the CLI's folder. */
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
  /** The CLI's folder, or `undefined` when there is none. */
  dir: string | undefined
  /** The state read from `clipact.json`; empty when it is missing or unreadable. */
  state: State
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A Standard Schema for `clipact.json` that keeps only valid fields and
 * never fails, so a hand-edited file loses a bad field instead of the rest.
 *
 * @see https://standardschema.dev
 */
const stateSchema: StandardSchemaV1<unknown, State> = {
  '~standard': {
    version: 1,
    vendor: 'clipact',
    validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { value: {} }
      }
      const { telemetry, notice, installId } = value as Record<string, unknown>
      return {
        value: {
          ...(telemetry === 'enabled' || telemetry === 'disabled'
            ? { telemetry }
            : {}),
          ...(notice === true ? { notice } : {}),
          ...(typeof installId === 'string' && UUID.test(installId)
            ? { installId }
            : {}),
        },
      }
    },
  },
}

/**
 * Opens `clipact.json` in a folder with iso-conf. A corrupt file reads as
 * empty, and the next write keeps a copy of it before replacing it. Each
 * write holds a lock, so parallel runs agree on one installation ID.
 *
 * @see https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf
 */
async function openState(dir: string) {
  const { Conf } = await import('iso-conf')
  return new Conf({
    cwd: dir,
    configName: CLIPACT_FILE,
    schema: stateSchema,
    clearInvalidConfig: true,
    lock: true,
  })
}

/** Reads `clipact.json` in a folder; returns `{}` on any failure. Never writes. */
export async function readState(dir: string): Promise<State> {
  try {
    return { ...(await openState(dir)).store }
  } catch {
    return {}
  }
}

/**
 * Changes `clipact.json` in a folder under its lock, creating the folder
 * first, and returns the saved state. Throws when it cannot be written.
 */
export async function updateState(
  dir: string,
  change: (state: State) => State
): Promise<State> {
  await ensureDir(dir)
  const conf = await openState(dir)
  return { ...conf.update((state) => change({ ...state })) }
}

/**
 * Decides whether telemetry is on. Any opt-out wins: `DO_NOT_TRACK`, then
 * `<PREFIX>_TELEMETRY=0`, then the saved `disable`. A sandbox without a
 * network, `CODEX_SANDBOX_NETWORK_DISABLED`, turns it off unless
 * `<PREFIX>_TELEMETRY=log` only prints events. Then `<PREFIX>_TELEMETRY=1`
 * or `log`, the saved `enable`, and the CLI's default. Without a `telemetry`
 * option, it reads only the environment opt-outs and never `clipact.json`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#opting-out
 */
export async function resolveTelemetry(
  cli: CliOptions,
  envPrefix: string,
  env: Env,
  dir: string | undefined
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
      dir,
      state: {},
    }
  }
  const state = dir ? await readState(dir) : {}
  const resolved = (status: TelemetryStatus, log = false) => ({
    status,
    log,
    dir,
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
  if (isSet(env.CODEX_SANDBOX_NETWORK_DISABLED) && raw !== 'log') {
    return resolved({
      enabled: false,
      optedOut: false,
      source: 'env',
      variable: 'CODEX_SANDBOX_NETWORK_DISABLED',
    })
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
 * values. Tokens are read as the command parser reads them, so a value that
 * looks like a flag, as in `--message --json`, is not a flag. Unknown names
 * are dropped, because a typo may hold a value.
 */
export function flagNames(
  args: string[],
  spec: CommandSpec | undefined
): string[] {
  const options: Record<
    string,
    { type: 'string' | 'boolean'; short?: string }
  > = {}
  for (const flag of FRAMEWORK_FLAGS) {
    options[flag.name] = {
      type: flag.value ? 'string' : 'boolean',
      ...(flag.short ? { short: flag.short } : {}),
    }
  }
  for (const field of spec?.fields ?? []) {
    options[field.flag] = {
      type: field.kind === 'boolean' ? 'boolean' : 'string',
    }
  }
  const { tokens } = parseArgs({
    args,
    options,
    strict: false,
    allowPositionals: true,
    allowNegative: true,
    tokens: true,
  })
  const names = new Set<string>()
  for (const token of tokens) {
    if (token.kind === 'option' && Object.hasOwn(options, token.name)) {
      names.add(
        token.rawName.startsWith('--no-') ? `no-${token.name}` : token.name
      )
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
  const ci = isSet(env.CI)
  const installId = await persist(cli, resolved, session, ci)
  const event = buildEvent(input, installId, ci)
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
 * A saved `enable` or `disable` counts as having seen the notice. The file
 * is read again under its lock before writing, so a choice saved while the
 * command ran is kept and parallel first runs keep one ID. Returns the
 * installation ID, or `null` in CI, whose home directory rarely survives the
 * job, and when it cannot be saved.
 */
async function persist(
  cli: CliOptions,
  resolved: ResolvedTelemetry,
  session: Session,
  ci: boolean
): Promise<string | null> {
  const { dir, state } = resolved
  const updates: State = {}
  if (!state.notice && !state.telemetry) {
    session.log(notice(cli))
    updates.notice = true
  }
  if (!state.installId && !ci) {
    updates.installId = randomUUID()
  }
  if (!dir) {
    return null
  }
  if (updates.notice || updates.installId) {
    try {
      const saved = await updateState(dir, (current) => {
        const installId = current.installId ?? updates.installId
        return {
          ...current,
          ...(updates.notice ? { notice: true } : {}),
          ...(installId ? { installId } : {}),
        }
      })
      Object.assign(state, saved)
    } catch (error) {
      if (session.debug) {
        session.log(
          `debug: cannot save ${join(dir, `${CLIPACT_FILE}.json`)}: ${error instanceof Error ? error.message : String(error)}`
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
  installId: string | null,
  ci: boolean
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
      mode: ci ? 'ci' : mode.interactive ? 'interactive' : 'noninteractive',
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
    const context = telemetryContexts.get(ctx)
    if (!context) {
      throw new TypeError('telemetry commands need a context from clipact')
    }
    const { env, envPrefix, dir } = context
    if (!dir) {
      throw noDir(frameworkVariables(envPrefix).config)
    }
    try {
      await updateState(dir, (state) => ({ ...state, telemetry: choice }))
    } catch (error) {
      throw unwritable(join(dir, `${CLIPACT_FILE}.json`), error)
    }
    const { status } = await resolveTelemetry(cli, envPrefix, env, dir)
    return ctx.ok(status)
  })
}
