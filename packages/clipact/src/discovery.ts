import type { AnyCommand, CliOptions, CommandNode } from './define.ts'
import { leaves } from './help.ts'
import type { CommandSpec, JsonSchema } from './spec.ts'

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
