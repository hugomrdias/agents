import type { Context, FieldOf, ParsedOf, Schema } from './define.ts'
import { DefinitionError } from './errors.ts'
import { type FieldSpec, type JsonSchema, resolveFields } from './spec.ts'

/**
 * Options for {@link defineGlobals}.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#environment-variables-and-secrets
 */
export interface GlobalsOptions<I extends Schema> {
  /** One object schema for every CLI-wide setting. */
  input: I
  /** The environment variable of every field, written out in full, such as `ACME_API_URL`. */
  env: { [K in FieldOf<I>]-?: string }
  /** Fields that are always redacted, in `--debug` output and `schema` defaults. */
  secrets?: FieldOf<I>[]
}

/** CLI-wide settings created by {@link defineGlobals}, read only from the environment. */
export interface Globals<I extends Schema = Schema>
  extends Readonly<GlobalsOptions<I>> {
  readonly kind: 'globals'
  /** Returns the validated values for a handler's context. */
  get(ctx: AnyContext): ParsedOf<I>
}

/** Any globals definition, regardless of its schema. */
// biome-ignore lint/suspicious/noExplicitAny: variance of the env and secrets types
export type AnyGlobals = Globals<any>

// biome-ignore lint/suspicious/noExplicitAny: any handler's context
type AnyContext = Context<any, any>

/** The resolved fields and JSON Schema of a globals definition. */
export interface GlobalsSpec {
  globals: AnyGlobals
  inputJsonSchema: JsonSchema
  fields: FieldSpec[]
}

/** The globals values of each handler context, keyed by the context. */
const bindings = new WeakMap<
  object,
  { globals: AnyGlobals; value: Record<string, unknown> }
>()

/**
 * Defines CLI-wide settings: one input schema whose fields come only from
 * environment variables. Pass the result to `defineCli({ globals })`, and
 * read the values in a handler with `globals.get(ctx)`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#environment-variables-and-secrets
 */
export function defineGlobals<I extends Schema>(
  options: GlobalsOptions<I>
): Globals<I> {
  const env = options.env as Record<string, string | undefined>
  for (const secret of options.secrets ?? []) {
    if (!env[secret]) {
      throw new TypeError(`Secret global "${secret}" needs an env mapping`)
    }
  }
  const globals: Globals<I> = Object.freeze({
    kind: 'globals',
    ...options,
    get(ctx: AnyContext): ParsedOf<I> {
      const binding = bindings.get(ctx)
      if (binding?.globals !== globals) {
        throw new TypeError(
          'globals.get() needs the context of a CLI defined with these globals'
        )
      }
      return binding.value as ParsedOf<I>
    },
  })
  return globals
}

/** Attaches validated globals values to a handler's context. */
export function bindGlobals(
  ctx: AnyContext,
  globals: AnyGlobals,
  value: Record<string, unknown>
): void {
  bindings.set(ctx, { globals, value })
}

const cache = new WeakMap<AnyGlobals, GlobalsSpec>()

/**
 * Resolves the fields of a globals definition and checks that each one has
 * an environment variable. Runs only when globals are read or described.
 */
export function resolveGlobalsSpec(globals: AnyGlobals): GlobalsSpec {
  const cached = cache.get(globals)
  if (cached) {
    return cached
  }
  const { inputJsonSchema, fields } = resolveFields(
    globals.input,
    { env: globals.env, secrets: globals.secrets ?? [], positionals: [] },
    'globals'
  )
  for (const field of fields) {
    if (!field.env) {
      throw new DefinitionError(
        'globals',
        `field "${field.name}" needs an env mapping`
      )
    }
  }
  const spec: GlobalsSpec = { globals, inputJsonSchema, fields }
  cache.set(globals, spec)
  return spec
}
