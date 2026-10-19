import {
  type AnyCommand,
  type CliOptions,
  type Command,
  type CommandNode,
  defineCommand,
  defineHandler,
  type Group,
  leaves,
  markBuiltin,
} from './define.ts'
import type { CliError, ErrorRegistry } from './errors.ts'
import { fromJsonSchema } from './json-schema.ts'
import {
  closest,
  findNode,
  type Route,
  route,
  unknownCommand,
} from './route.ts'
import {
  type CommandSpec,
  JSON_SCHEMA_TARGET,
  type JsonSchema,
  resolveSpec,
} from './spec.ts'

/** Input of the built-in `schema` command. */
interface SchemaInput {
  command?: string[]
  list: boolean
}

const schemaInput = fromJsonSchema<Partial<SchemaInput>, SchemaInput>({
  type: 'object',
  properties: {
    command: {
      type: 'array',
      items: { type: 'string' },
      description: 'Path of a command or group, such as "<group> <command>"',
    },
    list: {
      type: 'boolean',
      default: false,
      description: 'List the commands; the default without a command path',
    },
  },
  additionalProperties: false,
})

/** The built-in `schema` command. */
type SchemaCommand = Command<typeof schemaInput, undefined>

/**
 * JSON Schema of the result envelope: exactly one of `data` and `error`,
 * then optional `next` steps. Each command's `output` describes `data`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#result-envelope
 */
export const RESULT_SCHEMA: JsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      properties: {
        data: {
          type: ['object', 'array'],
          description: "The command's output, described by its output schema",
        },
        next: { $ref: '#/$defs/next' },
      },
      required: ['data'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        error: { $ref: '#/$defs/error' },
        next: { $ref: '#/$defs/next' },
      },
      required: ['error'],
      additionalProperties: false,
    },
  ],
  $defs: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable snake_case code' },
        message: { type: 'string' },
        retryable: {
          type: 'boolean',
          description: 'Running the same command again is safe and may succeed',
        },
        retryAfterSeconds: { type: 'number', minimum: 0 },
        details: { description: "Shaped by the code's details schema" },
      },
      required: ['code', 'message', 'retryable'],
      additionalProperties: false,
    },
    next: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          by: {
            enum: ['agent', 'user'],
            description: '"user" means a human must act; relay the step',
          },
          command: { type: 'string', description: 'Runnable as written' },
          description: { type: 'string' },
        },
        required: ['by', 'description'],
        additionalProperties: false,
      },
    },
  },
})

/** Summarizes a command for `schema --list`. */
function summary(path: string, command: AnyCommand): Record<string, unknown> {
  return {
    command: path,
    description: command.description,
    readOnly: command.readOnly === true,
    idempotent: command.idempotent === true,
    confirm: command.confirm !== undefined,
    dryRun: command.dryRun === true,
  }
}

/**
 * Builds the `schema --list` data: the command tree with one-line
 * descriptions and the result envelope's JSON Schema, in one call.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#discovery-and-schemas
 */
export function listSchema(
  cli: CliOptions,
  node: CommandNode,
  path: string[]
): Record<string, unknown> {
  return {
    name: cli.name,
    version: cli.version,
    commands: leaves(node, path).map(({ path: leafPath, command }) =>
      summary(leafPath, command)
    ),
    ...(cli.aliases && path.length === 0 ? { aliases: cli.aliases } : {}),
    result: RESULT_SCHEMA,
  }
}

/** Builds the `schema <command>` data: JSON Schemas, error codes, and behavior of one command. */
export function commandSchema(
  cli: CliOptions,
  spec: CommandSpec,
  registry: Readonly<ErrorRegistry>
): Record<string, unknown> {
  const { command } = spec
  let confirm: Record<string, unknown> | null = null
  if (typeof command.confirm === 'string') {
    confirm = { when: 'always', reason: command.confirm }
  } else if (command.confirm) {
    confirm = { when: 'conditional' }
  }
  return {
    command: spec.path,
    description: command.description,
    examples: command.examples ?? [],
    positionals: spec.positionals.map((field) => field.name),
    env: Object.fromEntries(
      spec.fields.flatMap((field) =>
        field.env ? [[field.name, field.env]] : []
      )
    ),
    secrets: spec.fields
      .filter((field) => field.secret)
      .map((field) => field.name),
    readOnly: command.readOnly === true,
    idempotent: command.idempotent === true,
    confirm,
    dryRun: command.dryRun === true,
    input: redactSecrets(spec),
    output: spec.outputJsonSchema ?? null,
    errors: describeErrors(registry, spec.errors),
    aliases: Object.entries(cli.aliases ?? {})
      .filter(([, target]) => target === spec.path)
      .map(([alias]) => alias),
  }
}

/** Maps each error code to its description and `details` JSON Schema, from the registry. */
function describeErrors(
  registry: Readonly<ErrorRegistry>,
  codes: string[]
): Record<string, { description: string | null; details: JsonSchema | null }> {
  return Object.fromEntries(
    codes.map((code) => {
      const definition = registry[code]
      return [
        code,
        {
          description: definition?.description ?? null,
          details:
            definition?.details?.['~standard'].jsonSchema.output(
              JSON_SCHEMA_TARGET
            ) ?? null,
        },
      ]
    })
  )
}

/** Removes defaults of secret fields from the input JSON Schema. */
function redactSecrets(spec: CommandSpec): JsonSchema {
  const secrets = spec.fields.filter((field) => field.secret)
  if (secrets.length === 0) {
    return spec.inputJsonSchema
  }
  const properties = {
    ...(spec.inputJsonSchema.properties as Record<string, JsonSchema>),
  }
  for (const field of secrets) {
    const {
      default: _default,
      examples: _examples,
      ...rest
    } = properties[field.name] ?? {}
    properties[field.name] = rest
  }
  return { ...spec.inputJsonSchema, properties }
}

/**
 * Builds the error for a `schema` path with words after the node it
 * resolved to, such as `schema artifacts put extra`. It reports the deepest
 * group on the path, so the `command` issue and `next` step stay in that
 * group, like an unknown command on the command line.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#execution-pipeline
 */
function trailingWords(
  cli: CliOptions,
  root: Group,
  routed: Extract<Route, { kind: 'node' }>
): CliError {
  const { node, path, rest } = routed
  const groupPath = node.kind === 'group' ? path : path.slice(0, -1)
  const group = findNode(root, groupPath) as Group
  const unmatched = [...path.slice(groupPath.length), ...rest]
  return unknownCommand(cli, {
    kind: 'unknown',
    group,
    path: groupPath,
    word: unmatched.join(' '),
    suggestion: closest(
      unmatched[0] as string,
      group.commands.map((candidate) => candidate.name)
    ),
  })
}

/**
 * Builds the built-in `schema` command, which prints the JSON Schemas of a
 * command, or the command list of the CLI or a group, as one JSON object.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#discovery-and-schemas
 */
export function schemaCommand(
  cli: CliOptions,
  root: Group,
  errors: Readonly<ErrorRegistry>
): SchemaCommand {
  const command: SchemaCommand = defineCommand({
    name: 'schema',
    description: 'JSON Schema for a command, or the command list',
    examples: [`${cli.name} schema --list`, `${cli.name} schema schema`],
    input: schemaInput,
    positionals: ['command'],
    readOnly: true,
    human: (data) => JSON.stringify(data, null, 2),
    handler: async () => ({ default: handler }),
  })
  const handler = defineHandler(command, ({ input, ok }) => {
    const words = input.command ?? []
    // Route like a command line, so an alias resolves to its canonical path.
    const routed = route(root, words, cli.aliases)
    if (routed.kind === 'unknown') {
      throw unknownCommand(cli, routed)
    }
    if (routed.rest.length > 0) {
      throw trailingWords(cli, root, routed)
    }
    const { node, path } = routed
    return ok(
      node.kind === 'command'
        ? commandSchema(cli, resolveSpec(node, path.join(' ')), errors)
        : listSchema(cli, node, path)
    )
  })
  return markBuiltin(command, { commandPath: 'command' })
}
