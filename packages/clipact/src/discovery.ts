import {
  type AnyCommand,
  type CliOptions,
  type Command,
  type CommandNode,
  defineCommand,
  defineHandler,
  type Group,
  markBuiltin,
} from './define.ts'
import { leaves } from './help.ts'
import { fromJsonSchema } from './json-schema.ts'
import { closest, findNode, unknownCommand } from './route.ts'
import { type CommandSpec, type JsonSchema, resolveSpec } from './spec.ts'

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
 * Builds the `schema --list` result: the command tree with one-line
 * descriptions, in one call.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#discovery-and-schemas
 */
export function listSchema(
  cli: CliOptions,
  node: CommandNode,
  path: string[]
): Record<string, unknown> {
  return {
    ok: true,
    name: cli.name,
    version: cli.version,
    commands: leaves(node, path).map(({ path: leafPath, command }) =>
      summary(leafPath, command)
    ),
    ...(cli.aliases && path.length === 0 ? { aliases: cli.aliases } : {}),
  }
}

/** Builds the `schema <command>` result: JSON Schemas and behavior of one command. */
export function commandSchema(
  cli: CliOptions,
  spec: CommandSpec
): Record<string, unknown> {
  const { command } = spec
  let confirm: Record<string, unknown> | null = null
  if (typeof command.confirm === 'string') {
    confirm = { when: 'always', reason: command.confirm }
  } else if (command.confirm) {
    confirm = { when: 'conditional' }
  }
  return {
    ok: true,
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
    errors: spec.errors,
    aliases: Object.entries(cli.aliases ?? {})
      .filter(([, target]) => target === spec.path)
      .map(([alias]) => alias),
  }
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
 * Builds the built-in `schema` command, which prints the JSON Schemas of a
 * command, or the command list of the CLI or a group, as one JSON object.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#discovery-and-schemas
 */
export function schemaCommand(cli: CliOptions, root: Group): SchemaCommand {
  const command: SchemaCommand = defineCommand({
    name: 'schema',
    description: 'JSON Schema for a command, or the command list',
    examples: [`${cli.name} schema --list`, `${cli.name} schema schema`],
    input: schemaInput,
    positionals: ['command'],
    readOnly: true,
    human: (data) => JSON.stringify({ ok: true, ...data }, null, 2),
    handler: async () => ({ default: handler }),
  })
  const handler = defineHandler(command, ({ input, ok }) => {
    const words = input.command ?? []
    const node = findNode(root, words)
    if (!node) {
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
    const { ok: _ok, ...data } =
      node.kind === 'command'
        ? commandSchema(cli, resolveSpec(node, words.join(' ')))
        : listSchema(cli, node, words)
    return ok(data)
  })
  return markBuiltin(command)
}
