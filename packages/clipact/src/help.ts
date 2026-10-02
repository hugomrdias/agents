import type { AnyCommand, CliOptions, CommandNode, Group } from './define.ts'
import { BUILTIN_ERROR_CODES } from './errors.ts'
import type { CommandSpec, FieldSpec, JsonSchema } from './spec.ts'

/** A leaf command with its full path. */
export interface Leaf {
  path: string
  command: AnyCommand
}

/** Lists every command below `node` with its path, depth first. */
export function leaves(node: CommandNode, prefix: string[] = []): Leaf[] {
  if (node.kind === 'command') {
    return [{ path: prefix.join(' '), command: node }]
  }
  return node.commands.flatMap((child) =>
    leaves(child, [...prefix, child.name])
  )
}

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

/** Returns the value placeholder for a field, such as `<mainnet|calibration>`. */
function valueLabel(field: FieldSpec): string {
  if (field.enum && field.enum.length <= 6) {
    return `<${field.enum.join('|')}>`
  }
  const kind = field.kind === 'array' ? field.itemKind : field.kind
  return `<${kind === 'unknown' ? 'value' : kind}>`
}

/** Returns the usage line for a command. */
export function usage(cli: CliOptions, spec: CommandSpec): string {
  const parts = [cli.name, spec.path]
  for (const field of spec.positionals) {
    const name = field.variadic ? `${field.name}...` : field.name
    parts.push(field.required ? `<${name}>` : `[${name}]`)
  }
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
  if (command.confirm) {
    flags.push(['--yes', 'Confirm without a prompt'])
  }
  if (command.dryRun) {
    flags.push(['--dry-run', 'Report what would happen without side effects'])
  }
  flags.push(['--input <file|->', 'Read input fields from a JSON object'])
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
    sections.push(
      `Error codes: ${[...(command.errors ?? []), ...BUILTIN_ERROR_CODES].join(', ')}`
    )
    sections.push(sideEffects(command).join('\n'))
    sections.push(
      `Output is one JSON object on stdout; exit code 0 when "ok" is true, else 1.\nFull schema: ${cli.name} schema ${spec.path}`
    )
  } else {
    if (examples) {
      sections.push(examples)
    }
    sections.push(sideEffects(command).join('\n'))
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
    sections.push(
      `Built-in:\n${columns([
        [
          'schema [command...]',
          'JSON Schema for a command, or the command list',
        ],
        ['completion <shell>', 'Print a bash, zsh, or fish completion script'],
      ])}`
    )
  }
  if (agent) {
    sections.push(
      `Run "${cli.name} <command> --help" for examples and flags, or "${cli.name} schema <command>" for JSON Schemas.\nOutput is one JSON object on stdout; exit code 0 when "ok" is true, else 1.`
    )
  } else {
    sections.push(globalFlags())
    sections.push(`Run "${cli.name} <command> --help" for details.`)
  }
  return `${sections.join('\n\n')}\n`
}

/** Lists the framework flags. */
function globalFlags(): string {
  return `Global flags:\n${columns([
    ['--json', 'Write one JSON result to stdout'],
    ['--format <human|json>', 'Choose the output format'],
    ['--agent, --no-agent', 'Override agent detection'],
    ['--debug', 'Show input sources and stack traces on stderr'],
    ['-h, --help', 'Show help'],
    ['--version', 'Show the version'],
  ])}`
}
