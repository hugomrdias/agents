import { StringDecoder } from 'node:string_decoder'
import { parseArgs } from 'node:util'
import { type Env, parseBoolean } from './agent.ts'
import { CliError, type InputIssue } from './errors.ts'
import type { Io } from './io.ts'
import { closest, FRAMEWORK_FLAGS } from './route.ts'
import type { CommandSpec, FieldKind, FieldSpec } from './spec.ts'

/** Framework values read while parsing a command's arguments. */
export interface FrameworkValues {
  input: string | undefined
  yes: boolean
  dryRun: boolean
}

/** Values collected from every source, where each came from, and the problems found. */
interface Collected {
  values: Record<string, unknown>
  sources: Record<string, string>
  issues: InputIssue[]
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
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli/framework-design.md#execution-pipeline
 */
export async function resolveInput(
  spec: CommandSpec,
  args: string[],
  io: Io,
  signal: AbortSignal
): Promise<ResolvedInput> {
  const collected: Collected = { values: {}, sources: {}, issues: [] }
  const { values, sources, issues } = collected
  const framework = parseCommandArgs(spec, args, collected)

  if (framework.input !== undefined) {
    const merged = await mergeInputJson(
      spec,
      framework.input,
      io,
      signal,
      collected
    )
    if (!merged) {
      // Every field would also be reported missing; report only the cause.
      throw invalidInput(issues)
    }
  }
  applyEnv(spec, io.env, collected)
  rejectControlCharacters(collected)

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
      const fieldSpec = spec.byName.get(field)
      const message =
        fieldSpec && values[field] === undefined && path === field
          ? missingMessage(fieldSpec)
          : issue.message
      const source = sources[field]
      issues.push(source ? { path, source, message } : { path, message })
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
export function invalidInput(issues: InputIssue[]): CliError {
  const [first] = issues
  const summary = first
    ? `${first.path ? `${first.path}: ` : ''}${first.message}`
    : 'Invalid input'
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''
  const end = /[.?!]$/.test(summary) && !more ? '' : '.'
  return new CliError({
    code: 'invalid_input',
    message: `${summary}${more}${end}`,
    retryable: false,
    details: issues,
  })
}

/** Reads flags and positionals into `values`, reporting unknown or malformed ones. */
function parseCommandArgs(
  spec: CommandSpec,
  args: string[],
  collected: Collected
): FrameworkValues {
  const { values, sources, issues } = collected
  const framework: FrameworkValues = {
    input: undefined,
    yes: false,
    dryRun: false,
  }
  const frameworkFlags = new Map(
    FRAMEWORK_FLAGS.filter((flag) => flag.when?.(spec.command) ?? true).map(
      (flag) => [flag.name, flag]
    )
  )
  const options: Record<string, { type: 'string' | 'boolean' }> = {}
  for (const flag of frameworkFlags.values()) {
    options[flag.name] = { type: flag.value ? 'string' : 'boolean' }
  }
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

  const flagIssue = (path: string, message: string) =>
    issues.push({ path, source: 'flag', message })
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
    const frameworkFlag = frameworkFlags.get(token.name)
    if (frameworkFlag) {
      if (negated && !frameworkFlag.negatable) {
        flagIssue(token.rawName, 'Unknown flag')
      } else if (!frameworkFlag.value && token.value !== undefined) {
        // `--yes=false` must not approve anything; switches take no value.
        flagIssue(token.rawName, `${token.rawName} does not take a value`)
      } else if (frameworkFlag.value) {
        if (token.value === undefined) {
          flagIssue(token.rawName, 'Requires a value')
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
      flagIssue(
        token.rawName,
        suggestion
          ? `Unknown flag; did you mean --${suggestion}?`
          : 'Unknown flag'
      )
      continue
    }
    if (field.secret) {
      flagIssue(field.name, `Secret values are read only from ${field.env}`)
      continue
    }
    let value: unknown
    if (field.kind === 'boolean') {
      value = negated
        ? false
        : token.value === undefined
          ? true
          : coerce('boolean', token.value)
    } else if (negated) {
      flagIssue(
        field.name,
        `--no-${field.flag} is only valid for boolean flags`
      )
      continue
    } else if (token.value === undefined) {
      flagIssue(field.name, `--${field.flag} requires a value`)
      continue
    } else if (field.kind === 'array') {
      const list = (values[field.name] as unknown[] | undefined) ?? []
      list.push(coerce(field.itemKind, token.value))
      value = list
    } else if (field.name in values) {
      flagIssue(field.name, `--${field.flag} was given more than once`)
      continue
    } else {
      value = coerce(field.kind, token.value)
    }
    values[field.name] = value
    sources[field.name] = 'flag'
  }

  assignPositionals(spec, positionals, collected)
  if (framework.input === '-' && positionals.includes('-')) {
    flagIssue(
      '--input',
      'Only one source can read stdin; "-" is also used as an argument'
    )
  }
  return framework
}

/** Assigns positional arguments to the command's positional fields in order. */
function assignPositionals(
  spec: CommandSpec,
  positionals: string[],
  { values, sources, issues }: Collected
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
  signal: AbortSignal,
  { values, sources, issues }: Collected
): Promise<boolean> {
  let text: string
  try {
    // Loaded on use, so commands without --input never pay for node:fs.
    const { readFile } = process.getBuiltinModule('node:fs/promises')
    text =
      location === '-'
        ? await readStream(io.stdin, signal)
        : await readFile(location, { encoding: 'utf8', signal })
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason
    }
    issues.push({
      path: '--input',
      source: 'flag',
      message: `Cannot read ${location === '-' ? 'stdin' : location}: ${(error as Error).message}`,
    })
    return false
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    issues.push({ path: '--input', source: 'input', message: 'Not valid JSON' })
    return false
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    issues.push({
      path: '--input',
      source: 'input',
      message: 'Must be a JSON object',
    })
    return false
  }
  for (const [key, value] of Object.entries(json)) {
    const field = spec.byName.get(key)
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
  return true
}

/** Fills missing fields from their environment variables. */
function applyEnv(
  spec: CommandSpec,
  env: Env,
  { values, sources, issues }: Collected
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
    // Decimal only: Number() would also accept "0x10", " 5 ", and "".
    return DECIMAL.test(raw) ? Number(raw) : raw
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

/** A decimal number such as `5`, `-1.5`, or `2e3`. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** C0 controls except tab, line feed, and carriage return, plus DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detects control characters
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/**
 * Rejects control characters (such as ANSI escapes or NUL) in values from
 * flags, positionals, and environment variables, a common sign of a
 * garbled command line. `--input` JSON is exempt; it can encode any text.
 */
function rejectControlCharacters({ values, sources, issues }: Collected): void {
  for (const [name, source] of Object.entries(sources)) {
    if (source === 'input') {
      continue
    }
    const items = ([] as unknown[]).concat(values[name])
    if (items.some((item) => typeof item === 'string' && CONTROL.test(item))) {
      issues.push({
        path: name,
        source,
        message: 'Contains control characters',
      })
    }
  }
}

/** Reads a stream to a string, giving up when `signal` aborts. */
function readStream(
  stream: NodeJS.ReadableStream,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    // Decodes across chunk boundaries so split multi-byte characters survive.
    const decoder = new StringDecoder('utf8')
    let text = ''
    const onData = (chunk: string | Buffer) => {
      text += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onEnd = () => {
      cleanup()
      resolve(text + decoder.end())
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      stream.pause()
      reject(signal.reason)
    }
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
