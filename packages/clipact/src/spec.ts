import type { AnyCommand, Schema } from './define.ts'
import { DefinitionError } from './errors.ts'

/** A JSON Schema object as produced by Standard JSON Schema converters. */
export type JsonSchema = Record<string, unknown>

/** The JSON type a field's command-line value is converted to. */
export type FieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'unknown'

/** Everything the runtime needs to know about one input field. */
export interface FieldSpec {
  name: string
  /** Flag name without dashes, such as `private-key` for `privateKey`. */
  flag: string
  kind: FieldKind
  /** Kind of array items. */
  itemKind: FieldKind
  required: boolean
  description: string | undefined
  default: unknown
  enum: unknown[] | undefined
  positional: boolean
  /** The last positional, collecting remaining arguments. */
  variadic: boolean
  env: string | undefined
  secret: boolean
}

/** A command's resolved fields and JSON Schemas. */
export interface CommandSpec {
  path: string
  command: AnyCommand
  input: Schema
  inputJsonSchema: JsonSchema
  outputJsonSchema: JsonSchema | undefined
  fields: FieldSpec[]
  positionals: FieldSpec[]
  byFlag: Map<string, FieldSpec>
}

/** Flags owned by the framework; input fields may not use these names. */
export const FRAMEWORK_FLAGS = new Set([
  'json',
  'format',
  'agent',
  'input',
  'yes',
  'dry-run',
  'debug',
  'help',
  'version',
])

const JSON_SCHEMA_TARGET = { target: 'draft-2020-12' } as const

/** Standard schema for commands without `input`: an empty object. */
export const EMPTY_INPUT: Schema = {
  '~standard': {
    version: 1,
    vendor: 'clipact',
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'Expected an object' }] }
      }
      const keys = Object.keys(value)
      if (keys.length > 0) {
        return {
          issues: keys.map((key) => ({
            message: 'This command accepts no input',
            path: [key],
          })),
        }
      }
      return { value: {} }
    },
    jsonSchema: {
      input: () => ({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      output: () => ({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
    },
  },
}

/** Converts `privateKey` to `private-key`. */
export function toFlag(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

const cache = new WeakMap<AnyCommand, CommandSpec>()

/**
 * Resolves a command's fields from its input JSON Schema and checks the
 * definition. Runs only for the command being executed or described, so
 * startup never converts every schema.
 */
export function resolveSpec(command: AnyCommand, path: string): CommandSpec {
  const cached = cache.get(command)
  if (cached) {
    return cached
  }
  const input: Schema = command.input ?? EMPTY_INPUT
  const inputJsonSchema =
    input['~standard'].jsonSchema.input(JSON_SCHEMA_TARGET)
  const outputJsonSchema =
    command.output?.['~standard'].jsonSchema.output(JSON_SCHEMA_TARGET)
  if (inputJsonSchema.type !== 'object') {
    throw new DefinitionError(path, 'input must be an object schema')
  }
  const properties = (inputJsonSchema.properties ?? {}) as Record<
    string,
    JsonSchema
  >
  const required = new Set((inputJsonSchema.required ?? []) as string[])
  const positionalNames: string[] = command.positionals ?? []
  const secrets = new Set<string>(command.secrets ?? [])
  const env: Record<string, string | undefined> = command.env ?? {}

  for (const name of [...positionalNames, ...secrets, ...Object.keys(env)]) {
    if (!(name in properties)) {
      throw new DefinitionError(path, `"${name}" is not an input field`)
    }
  }

  const fields: FieldSpec[] = Object.entries(properties).map(
    ([name, schema]) => {
      const resolved = deref(schema, inputJsonSchema)
      const kind = kindOf(resolved, inputJsonSchema)
      const items =
        kind === 'array'
          ? deref((resolved.items ?? {}) as JsonSchema, inputJsonSchema)
          : undefined
      const index = positionalNames.indexOf(name)
      return {
        name,
        flag: toFlag(name),
        kind,
        itemKind: items ? kindOf(items, inputJsonSchema) : 'unknown',
        required: required.has(name),
        description:
          (resolved.description as string | undefined) ??
          (schema.description as string | undefined),
        default: schema.default ?? resolved.default,
        enum: (resolved.enum ?? items?.enum) as unknown[] | undefined,
        positional: index !== -1,
        variadic:
          index !== -1 &&
          index === positionalNames.length - 1 &&
          kind === 'array',
        env: env[name],
        secret: secrets.has(name),
      }
    }
  )

  const positionals = positionalNames.map(
    (name) => fields.find((field) => field.name === name) as FieldSpec
  )
  let seenOptional = false
  for (const [index, field] of positionals.entries()) {
    if (field.kind === 'array' && index !== positionals.length - 1) {
      throw new DefinitionError(
        path,
        `only the last positional may be an array ("${field.name}")`
      )
    }
    if (field.kind === 'boolean' || field.kind === 'object') {
      throw new DefinitionError(
        path,
        `positional "${field.name}" must not be a ${field.kind}`
      )
    }
    if (field.secret) {
      throw new DefinitionError(
        path,
        `secret "${field.name}" cannot be positional`
      )
    }
    if (field.required && seenOptional) {
      throw new DefinitionError(
        path,
        `required positional "${field.name}" follows an optional one`
      )
    }
    seenOptional ||= !field.required
  }

  const byFlag = new Map<string, FieldSpec>()
  for (const field of fields) {
    if (FRAMEWORK_FLAGS.has(field.flag)) {
      throw new DefinitionError(
        path,
        `field "${field.name}" clashes with the framework flag --${field.flag}`
      )
    }
    byFlag.set(field.flag, field)
  }

  const spec: CommandSpec = {
    path,
    command,
    input,
    inputJsonSchema,
    outputJsonSchema,
    fields,
    positionals,
    byFlag,
  }
  cache.set(command, spec)
  return spec
}

/** Follows a local `$ref` such as `#/$defs/Network`. */
function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    return schema
  }
  let target: unknown = root
  for (const part of ref.slice(2).split('/')) {
    target = (target as Record<string, unknown> | undefined)?.[part]
  }
  return (target as JsonSchema | undefined) ?? schema
}

/** Returns the single non-null JSON type a value must have, or `unknown`. */
function kindOf(schema: JsonSchema, root: JsonSchema): FieldKind {
  const kinds = new Set<FieldKind>()
  const visit = (node: JsonSchema) => {
    const resolved = deref(node, root)
    const branches = (resolved.anyOf ?? resolved.oneOf) as
      | JsonSchema[]
      | undefined
    if (branches) {
      for (const branch of branches) {
        visit(branch)
      }
      return
    }
    if ('const' in resolved) {
      kinds.add(kindOfValue(resolved.const))
      return
    }
    if (Array.isArray(resolved.enum)) {
      for (const value of resolved.enum) {
        kinds.add(kindOfValue(value))
      }
      return
    }
    const types = ([] as unknown[]).concat(resolved.type ?? [])
    if (types.length === 0) {
      kinds.add('unknown')
    }
    for (const type of types) {
      if (type !== 'null') {
        kinds.add(type as FieldKind)
      }
    }
  }
  visit(schema)
  kinds.delete('null' as FieldKind)
  if (kinds.size === 2 && kinds.has('integer') && kinds.has('number')) {
    return 'number'
  }
  return kinds.size === 1 ? ([...kinds][0] as FieldKind) : 'unknown'
}

/** Maps a JavaScript value to its JSON type. */
function kindOfValue(value: unknown): FieldKind {
  if (value === null) {
    return 'null' as FieldKind
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  const type = typeof value
  return type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'object'
    ? type
    : 'unknown'
}
