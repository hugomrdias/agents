import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import type { Env } from './agent.ts'
import { CliError, type InputIssue } from './errors.ts'
import type { Io } from './io.ts'
import { closest } from './route.ts'
import type { CommandSpec, FieldKind, FieldSpec } from './spec.ts'

/** Framework values read while parsing a command's arguments. */
export interface FrameworkValues {
  input: string | undefined
  yes: boolean
  dryRun: boolean
}

/** Validated input and where each value came from. */
export interface ResolvedInput {
  value: Record<string, unknown>
  sources: Record<string, string>
  framework: FrameworkValues
}

/**
 * Parses arguments, merges `--input` JSON and environment fallbacks, and
 * validates the result against the command's input schema. All problems are
 * reported at once as one `invalid_input` error.
 *
 * @see https://github.com/filoz/foc-cli/blob/main/docs/cli-framework-design.md#execution-pipeline
 */
export async function resolveInput(
  spec: CommandSpec,
  args: string[],
  io: Io
): Promise<ResolvedInput> {
  const issues: InputIssue[] = []
  const values: Record<string, unknown> = {}
  const sources: Record<string, string> = {}
  const framework = parseCommandArgs(spec, args, values, sources, issues)

  if (framework.input !== undefined) {
    await mergeInputJson(spec, framework.input, io, values, sources, issues)
  }
  applyEnv(spec, io.env, values, sources, issues)

  const flagged = new Set(issues.map((issue) => issue.path))
  const result = await spec.input['~standard'].validate(values)
  if (result.issues) {
    for (const issue of result.issues) {
      const path = (issue.path ?? [])
        .map((part) =>
          typeof part === 'object' ? String(part.key) : String(part)
        )
        .join('.')
      const field = path.split('.')[0] ?? ''
      if (flagged.has(field)) {
        continue
      }
      const fieldSpec = spec.fields.find(
        (candidate) => candidate.name === field
      )
      const message =
        fieldSpec && values[field] === undefined && path === field
          ? missingMessage(fieldSpec)
          : issue.message
      issues.push(withSource({ path, message }, sources[field]))
    }
  }
  if (issues.length > 0 || !('value' in result)) {
    throw invalidInput(issues)
  }

  const value = result.value as Record<string, unknown>
  for (const field of spec.fields) {
    if (!(field.name in sources) && value[field.name] !== undefined) {
      sources[field.name] = 'default'
    }
  }
  return { value, sources, framework }
}

/** Creates the `invalid_input` error from all input issues. */
function invalidInput(issues: InputIssue[]): CliError {
  const [first] = issues
  const summary = first
    ? `${first.path ? `${first.path}: ` : ''}${first.message}`
    : 'Invalid input'
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''
  return new CliError({
    code: 'invalid_input',
    message: `${summary}${more}.`,
    retryable: false,
    details: issues,
  })
}

/** Adds `source` only when known, keeping the JSON compact. */
function withSource(issue: InputIssue, source: string | undefined): InputIssue {
  return source ? { path: issue.path, source, message: issue.message } : issue
}

/** Reads flags and positionals into `values`, reporting unknown or malformed ones. */
function parseCommandArgs(
  spec: CommandSpec,
  args: string[],
  values: Record<string, unknown>,
  sources: Record<string, string>,
  issues: InputIssue[]
): FrameworkValues {
  const { command } = spec
  const framework: FrameworkValues = {
    input: undefined,
    yes: false,
    dryRun: false,
  }
  const frameworkOptions: Record<string, { type: 'string' | 'boolean' }> = {
    json: { type: 'boolean' },
    format: { type: 'string' },
    agent: { type: 'boolean' },
    debug: { type: 'boolean' },
    help: { type: 'boolean' },
    version: { type: 'boolean' },
    input: { type: 'string' },
  }
  if (command.confirm) {
    frameworkOptions.yes = { type: 'boolean' }
  }
  if (command.dryRun) {
    frameworkOptions['dry-run'] = { type: 'boolean' }
  }
  const options: Record<
    string,
    { type: 'string' | 'boolean'; multiple?: boolean }
  > = { ...frameworkOptions }
  for (const field of spec.fields) {
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

  const positionals: string[] = []
  // An unknown flag probably takes a value; skip it instead of reporting it twice.
  let skipIndex = -1
  for (const token of tokens) {
    if (token.kind === 'positional') {
      if (token.index !== skipIndex) {
        positionals.push(token.value)
      }
      continue
    }
    if (token.kind !== 'option') {
      continue
    }
    const negated = token.rawName.startsWith('--no-')
    if (token.name in frameworkOptions) {
      if (negated && token.name !== 'agent') {
        issues.push({
          path: token.rawName,
          source: 'flag',
          message: 'Unknown flag',
        })
      } else if (frameworkOptions[token.name]?.type === 'string') {
        if (token.value === undefined) {
          issues.push({
            path: token.rawName,
            source: 'flag',
            message: 'Requires a value',
          })
        } else if (token.name === 'input') {
          framework.input = token.value
        }
      } else if (token.name === 'yes') {
        framework.yes = true
      } else if (token.name === 'dry-run') {
        framework.dryRun = true
      }
      continue
    }

    const field = spec.byFlag.get(token.name)
    if (!field) {
      if (token.value === undefined) {
        skipIndex = token.index + 1
      }
      const suggestion = closest(
        token.name,
        Object.keys(options).filter((name) => !spec.byFlag.get(name)?.secret)
      )
      issues.push({
        path: token.rawName,
        source: 'flag',
        message: suggestion
          ? `Unknown flag; did you mean --${suggestion}?`
          : 'Unknown flag',
      })
      continue
    }
    if (field.secret) {
      issues.push({
        path: field.name,
        source: 'flag',
        message: `Secret values are read only from ${field.env}`,
      })
      continue
    }
    let value: unknown
    if (field.kind === 'boolean') {
      if (negated) {
        value = false
      } else if (token.value === undefined) {
        value = true
      } else {
        value = parseBoolean(token.value) ?? token.value
      }
    } else if (negated) {
      issues.push({
        path: field.name,
        source: 'flag',
        message: `--no-${field.flag} is only valid for boolean flags`,
      })
      continue
    } else if (token.value === undefined) {
      issues.push({
        path: field.name,
        source: 'flag',
        message: `--${field.flag} requires a value`,
      })
      continue
    } else if (field.kind === 'array') {
      const list = (values[field.name] as unknown[] | undefined) ?? []
      list.push(coerce(field.itemKind, token.value))
      value = list
    } else if (field.name in values) {
      issues.push({
        path: field.name,
        source: 'flag',
        message: `--${field.flag} was given more than once`,
      })
      continue
    } else {
      value = coerce(field.kind, token.value)
    }
    values[field.name] = value
    sources[field.name] = 'flag'
  }

  assignPositionals(spec, positionals, values, sources, issues)
  if (framework.input === '-' && positionals.includes('-')) {
    issues.push({
      path: '--input',
      source: 'flag',
      message:
        'Only one source can read stdin; "-" is also used as an argument',
    })
  }
  return framework
}

/** Assigns positional arguments to the command's positional fields in order. */
function assignPositionals(
  spec: CommandSpec,
  positionals: string[],
  values: Record<string, unknown>,
  sources: Record<string, string>,
  issues: InputIssue[]
): void {
  let index = 0
  for (const field of spec.positionals) {
    if (index >= positionals.length) {
      break
    }
    const taken = field.variadic
      ? positionals.slice(index)
      : [positionals[index] as string]
    index += taken.length
    if (field.name in values) {
      issues.push({
        path: field.name,
        source: 'positional',
        message: `Given both as an argument and as --${field.flag}`,
      })
      continue
    }
    values[field.name] = field.variadic
      ? taken.map((item) => coerce(field.itemKind, item))
      : coerce(field.kind, taken[0] as string)
    sources[field.name] = 'positional'
  }
  for (const extra of positionals.slice(index)) {
    issues.push({
      path: extra,
      source: 'positional',
      message: 'Unexpected argument',
    })
  }
}

/** Merges the `--input` JSON object, rejecting fields also given as arguments. */
async function mergeInputJson(
  spec: CommandSpec,
  location: string,
  io: Io,
  values: Record<string, unknown>,
  sources: Record<string, string>,
  issues: InputIssue[]
): Promise<void> {
  let text: string
  try {
    text =
      location === '-'
        ? await readStream(io.stdin)
        : await readFile(location, 'utf8')
  } catch (error) {
    issues.push({
      path: '--input',
      source: 'flag',
      message: `Cannot read ${location === '-' ? 'stdin' : location}: ${(error as Error).message}`,
    })
    return
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    issues.push({ path: '--input', source: 'input', message: 'Not valid JSON' })
    return
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    issues.push({
      path: '--input',
      source: 'input',
      message: 'Must be a JSON object',
    })
    return
  }
  for (const [key, value] of Object.entries(json)) {
    const field = spec.fields.find((candidate) => candidate.name === key)
    if (field?.secret) {
      issues.push({
        path: key,
        source: 'input',
        message: `Secret values are read only from ${field.env}`,
      })
    } else if (key in values) {
      issues.push({
        path: key,
        source: 'input',
        message: `Given both in --input and as ${sources[key] === 'positional' ? 'an argument' : `--${field?.flag ?? key}`}`,
      })
    } else {
      values[key] = value
      sources[key] = 'input'
    }
  }
}

/** Fills missing fields from their environment variables. */
function applyEnv(
  spec: CommandSpec,
  env: Env,
  values: Record<string, unknown>,
  sources: Record<string, string>,
  issues: InputIssue[]
): void {
  for (const field of spec.fields) {
    if (!field.env || field.name in values) {
      continue
    }
    const raw = env[field.env]
    if (raw === undefined || raw === '') {
      continue
    }
    let value: unknown
    if (field.kind === 'array') {
      value = raw.split(',').map((item) => coerce(field.itemKind, item.trim()))
    } else if (field.kind === 'boolean') {
      value = parseBoolean(raw)
      if (value === undefined) {
        issues.push({
          path: field.name,
          source: `env:${field.env}`,
          message: 'Expected true, false, 1, or 0',
        })
        continue
      }
    } else {
      value = coerce(field.kind, raw)
    }
    values[field.name] = value
    sources[field.name] = `env:${field.env}`
  }
}

/** Converts a string to a field's JSON type, leaving it unchanged if it does not fit. */
function coerce(kind: FieldKind, raw: string): unknown {
  if (kind === 'number' || kind === 'integer') {
    const number = Number(raw)
    return raw.trim() !== '' && Number.isFinite(number) ? number : raw
  }
  if (kind === 'boolean') {
    return parseBoolean(raw) ?? raw
  }
  if (kind === 'object' || kind === 'array') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Parses common boolean spellings. */
function parseBoolean(raw: string): boolean | undefined {
  if (raw === 'true' || raw === '1') {
    return true
  }
  if (raw === 'false' || raw === '0') {
    return false
  }
  return undefined
}

/** Reads a stream to a string. */
async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    text +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  return text
}

/** Explains how to supply a missing required field. */
function missingMessage(field: FieldSpec): string {
  if (field.secret) {
    return `Required; set ${field.env}`
  }
  const how = field.positional
    ? `pass <${field.name}> or --${field.flag}`
    : `pass --${field.flag}`
  return `Required; ${how}${field.env ? ` or set ${field.env}` : ''}`
}
