import type { Env } from './agent.ts'
import {
  type CliOptions,
  type Command,
  defineCommand,
  defineGroup,
  type Group,
  type Handler,
  type TelemetryStatus,
} from './define.ts'
import { fromJsonSchema } from './json-schema.ts'

/**
 * The invocation details that the framework's `telemetry` handlers need, by
 * handler context. Handlers otherwise never see the environment, and the map
 * is not exported from the package.
 */
export const telemetryContexts: WeakMap<object, TelemetryContext> =
  new WeakMap()

/** What the `telemetry` handlers need from the invocation. */
export interface TelemetryContext {
  env: Env
  envPrefix: string
}

/** Builds the output schema of the `telemetry` commands. */
function statusSchema() {
  return fromJsonSchema<TelemetryStatus>({
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        description: 'The CLI sends usage events',
      },
      optedOut: {
        type: 'boolean',
        description:
          'DO_NOT_TRACK, <PREFIX>_TELEMETRY=0, or telemetry disable turned telemetry off',
      },
      source: {
        type: 'string',
        enum: ['env', 'config', 'default', 'unconfigured'],
        description: 'What decided enabled',
      },
      variable: {
        type: 'string',
        description: 'The environment variable behind the answer',
      },
    },
    required: ['enabled', 'optedOut', 'source'],
    additionalProperties: false,
  })
}

/** A `telemetry` command: no input, the status as output. */
export type TelemetryCommand = Command<
  undefined,
  ReturnType<typeof statusSchema>
>

/** Describes a status for humans, such as `Telemetry is off (DO_NOT_TRACK).` */
function describeStatus(status: TelemetryStatus): string {
  const reason =
    status.variable ??
    (status.source === 'config' ? 'saved choice' : status.source)
  return `Telemetry is ${status.enabled ? 'on' : 'off'} (${reason}).`
}

/** Loads a handler from `telemetry.run.ts` only when its command runs. */
function lazy(create: (run: typeof import('./telemetry.run.ts')) => Handler) {
  return async () => ({ default: create(await import('./telemetry.run.ts')) })
}

/**
 * Builds the `telemetry` group: `status`, `enable`, and `disable`. These
 * commands never send an event themselves.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#opting-out
 */
export function telemetryGroup(cli: CliOptions): Group {
  const statusOutput = statusSchema()
  const status: TelemetryCommand = defineCommand({
    name: 'status',
    description: 'Report whether telemetry is on and what decided it',
    examples: [`${cli.name} telemetry status --json`],
    output: statusOutput,
    readOnly: true,
    human: describeStatus,
    handler: lazy((run) => run.statusHandler(status)),
  })
  const enable: TelemetryCommand = defineCommand({
    name: 'enable',
    description: 'Save the choice to send usage events',
    examples: [`${cli.name} telemetry enable`],
    output: statusOutput,
    errors: ['state_unwritable'],
    idempotent: true,
    human: describeStatus,
    handler: lazy((run) => run.saveHandler(cli, enable, 'enabled')),
  })
  const disable: TelemetryCommand = defineCommand({
    name: 'disable',
    description: 'Save the choice to send no usage events',
    examples: [`${cli.name} telemetry disable`],
    output: statusOutput,
    errors: ['state_unwritable'],
    idempotent: true,
    human: describeStatus,
    handler: lazy((run) => run.saveHandler(cli, disable, 'disabled')),
  })
  return defineGroup({
    name: 'telemetry',
    description: 'Show or change whether this CLI sends usage events',
    commands: [status, enable, disable],
  })
}
