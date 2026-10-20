import {
  type AnyCommand,
  type CliOptions,
  type Group,
  isBuiltin,
  leaves,
} from './define.ts'
import { resolveGlobalsSpec } from './globals.ts'
import { frameworkVariables, resolveEnvPrefix } from './mode.ts'
import { FRAMEWORK_FLAGS, type FrameworkFlag, flagTokens } from './route.ts'
import {
  type CommandSpec,
  type FieldSpec,
  type JsonSchema,
  resolveSpec,
} from './spec.ts'

/** The output contract, repeated in agent help. */
const CONTRACT =
  'Output is one JSON object on stdout: "data" on success (exit code 0) or "error" on failure (exit code 1), then optional "next" steps.'

/** Formats rows as two aligned columns. */
function columns(rows: [string, string][], indent = '  '): string {
  const width = Math.min(32, Math.max(0, ...rows.map(([left]) => left.length)))
  return rows
    .map(([left, right]) =>
      right
        ? left.length > width
          ? `${indent}${left}\n${indent}${' '.repeat(width + 2)}${right}`
          : `${indent}${left.padEnd(width)}  ${right}`
        : `${indent}${left}`
    )
    .join('\n')
}

/** Formats a framework flag as a help row, such as `-h, --help`. */
function flagRow(flag: FrameworkFlag): [string, string] {
  const tokens = flagTokens(flag).join(', ')
  return [
    flag.value ? `${tokens} ${flag.value.label}` : tokens,
    flag.description,
  ]
}

/** Returns the value placeholder for a field, such as `<mainnet|calibration>`. */
function valueLabel(field: FieldSpec): string {
  if (field.enum && field.enum.length <= 6) {
    return `<${field.enum.join('|')}>`
  }
  const kind = field.kind === 'array' ? field.itemKind : field.kind
  return `<${kind === 'unknown' ? 'value' : kind}>`
}

/** Returns the positional placeholders of a command, such as `<path>` and `[tags...]`. */
function positionalUsage(spec: CommandSpec): string[] {
  return spec.positionals.map((field) => {
    const name = field.variadic ? `${field.name}...` : field.name
    return field.required ? `<${name}>` : `[${name}]`
  })
}

/** Returns the usage line for a command. */
export function usage(cli: CliOptions, spec: CommandSpec): string {
  const parts = [cli.name, spec.path, ...positionalUsage(spec)]
  for (const field of spec.fields) {
    if (!(field.positional || field.secret) && field.required) {
      parts.push(`--${field.flag} ${valueLabel(field)}`)
    }
  }
  if (
    spec.fields.some(
      (field) => !(field.positional || field.secret || field.required)
    )
  ) {
    parts.push('[flags]')
  }
  return parts.join(' ')
}

/** Describes a field's constraints after its description. */
function fieldNotes(field: FieldSpec): string {
  const notes: string[] = []
  if (field.required && !field.positional) {
    notes.push('required')
  }
  if (field.default !== undefined && !field.secret) {
    notes.push(`default: ${JSON.stringify(field.default)}`)
  }
  if (field.kind === 'array' && !field.positional) {
    notes.push('repeatable')
  }
  if (field.env && !field.secret) {
    notes.push(`env: ${field.env}`)
  }
  const text = field.description ?? ''
  return notes.length > 0 ? `${text} (${notes.join('; ')})`.trim() : text
}

/**
 * Lists the CLI's environment variables for root help: each global, then
 * the framework variables.
 */
function environmentRows(cli: CliOptions): [string, string][] {
  const rows: [string, string][] = []
  if (cli.globals) {
    for (const field of resolveGlobalsSpec(cli.globals).fields) {
      const notes: string[] = []
      if (field.required) {
        notes.push('required')
      }
      if (field.default !== undefined && !field.secret) {
        notes.push(`default: ${JSON.stringify(field.default)}`)
      }
      if (field.secret) {
        notes.push('secret')
      }
      const text = field.description ?? field.name
      rows.push([
        field.env as string,
        notes.length > 0 ? `${text} (${notes.join('; ')})` : text,
      ])
    }
  }
  const { output, agent, telemetry } = frameworkVariables(resolveEnvPrefix(cli))
  rows.push([output, 'Default output format: json or human'])
  rows.push([agent, 'Force or disable agent mode: 1, 0, true, or false'])
  if (cli.telemetry) {
    rows.push([
      telemetry,
      'Turn usage telemetry on or off, or print events: 1, 0, true, false, or log',
    ])
  }
  return rows
}

/** Points command help at the global variables listed in root help. */
function globalsPointer(cli: CliOptions): string | undefined {
  return cli.globals
    ? `Global environment variables: ${cli.name} --help`
    : undefined
}

/** Lists the output fields of a JSON Schema as `name (type)`. */
function outputFields(schema: JsonSchema | undefined): string | undefined {
  const properties = schema?.properties as
    | Record<string, JsonSchema>
    | undefined
  if (!properties) {
    return undefined
  }
  return Object.entries(properties)
    .map(([name, property]) => {
      const type = ([] as unknown[]).concat(property.type ?? 'object')
      return `${name} (${type.join('|')})`
    })
    .join(', ')
}

/** Lists the side-effect properties of a command. */
function sideEffects(command: AnyCommand): string[] {
  const lines: string[] = []
  if (command.readOnly) {
    lines.push('Read-only; safe to retry.')
  } else if (command.idempotent) {
    lines.push('Idempotent; safe to repeat with the same input.')
  } else {
    lines.push('Changes state; not idempotent.')
  }
  if (typeof command.confirm === 'string') {
    lines.push(
      `Requires confirmation: ${command.confirm} Pass --yes when not interactive.`
    )
  } else if (command.confirm) {
    lines.push(
      'May require confirmation depending on input; pass --yes when not interactive.'
    )
  }
  return lines
}

/** Renders help for a command in human or agent style. */
export function commandHelp(
  cli: CliOptions,
  spec: CommandSpec,
  agent: boolean
): string {
  const { command } = spec
  const sections: string[] = []
  const examples = command.examples?.length
    ? `Examples:\n${command.examples.map((example) => `  ${example}`).join('\n')}`
    : undefined
  const positional = spec.positionals.map((field): [string, string] => [
    field.name,
    fieldNotes(field),
  ])
  const flags = spec.fields
    .filter((field) => !(field.positional || field.secret))
    .map((field): [string, string] => [
      field.kind === 'boolean'
        ? `--${field.flag}`
        : `--${field.flag} ${valueLabel(field)}`,
      fieldNotes(field),
    ])
  for (const flag of FRAMEWORK_FLAGS) {
    if (!flag.global && (flag.when?.(command) ?? true)) {
      flags.push(flagRow(flag))
    }
  }
  const environment = spec.fields
    .filter((field) => field.secret)
    .map((field): [string, string] => [
      field.env as string,
      `${field.description ?? field.name} (secret${field.required ? ', required' : ''})`,
    ])

  sections.push(`${cli.name} ${spec.path}: ${command.description}`)
  if (agent && examples) {
    sections.push(examples)
  }
  sections.push(`Usage:\n  ${usage(cli, spec)}`)
  if (positional.length > 0) {
    sections.push(`Arguments:\n${columns(positional)}`)
  }
  sections.push(`Flags:\n${columns(flags)}`)
  if (environment.length > 0) {
    sections.push(`Environment:\n${columns(environment)}`)
  }
  if (agent) {
    const output = outputFields(spec.outputJsonSchema)
    if (output) {
      sections.push(`Output fields: ${output}`)
    }
    sections.push(`Error codes: ${spec.errors.join(', ')}`)
    sections.push(sideEffects(command).join('\n'))
    const pointer = globalsPointer(cli)
    if (pointer) {
      sections.push(pointer)
    }
    sections.push(`${CONTRACT}\nFull schema: ${cli.name} schema ${spec.path}`)
  } else {
    if (examples) {
      sections.push(examples)
    }
    sections.push(sideEffects(command).join('\n'))
    const pointer = globalsPointer(cli)
    if (pointer) {
      sections.push(pointer)
    }
    sections.push(globalFlags())
  }
  return `${sections.join('\n\n')}\n`
}

/** Renders help for the root or a group. */
export function groupHelp(
  cli: CliOptions,
  group: Group,
  path: string[],
  agent: boolean
): string {
  const isRoot = path.length === 0
  const sections: string[] = []
  const title = isRoot
    ? `${cli.name} ${cli.version}${cli.description ? `: ${cli.description}` : ''}`
    : `${cli.name} ${path.join(' ')}: ${group.description}`
  sections.push(title)
  sections.push(`Usage:\n  ${[cli.name, ...path].join(' ')} <command> [flags]`)
  const rows = leaves(group, path).map(({ path: leafPath, command }) => {
    const markers = [
      command.readOnly ? 'read-only' : undefined,
      command.confirm ? 'confirm' : undefined,
    ].filter(Boolean)
    return [
      leafPath,
      `${command.description}${agent && markers.length > 0 ? ` [${markers.join(', ')}]` : ''}`,
    ] as [string, string]
  })
  sections.push(`Commands:\n${columns(rows)}`)
  if (isRoot) {
    const builtins = group.commands
      .filter((node) => node.kind === 'command' && isBuiltin(node))
      .map((command): [string, string] => [
        [
          command.name,
          ...positionalUsage(resolveSpec(command as AnyCommand, command.name)),
        ].join(' '),
        command.description,
      ])
    if (builtins.length > 0) {
      sections.push(`Built-in:\n${columns(builtins)}`)
    }
    sections.push(`Environment:\n${columns(environmentRows(cli))}`)
  }
  if (agent) {
    sections.push(
      `Run "${cli.name} <command> --help" for examples and flags, or "${cli.name} schema <command>" for JSON Schemas.\n${CONTRACT}`
    )
  } else {
    sections.push(globalFlags())
    sections.push(`Run "${cli.name} <command> --help" for details.`)
  }
  return `${sections.join('\n\n')}\n`
}

/** Lists the framework flags. */
function globalFlags(): string {
  return `Global flags:\n${columns(
    FRAMEWORK_FLAGS.filter((flag) => flag.global).map(flagRow)
  )}`
}
