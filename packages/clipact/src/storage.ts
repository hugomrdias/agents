import { isAbsolute, join, relative } from 'node:path'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Conf } from 'iso-conf'
import type { Env } from './agent.ts'
import type { Context, StorageStatus } from './define.ts'
import { CliError, type InputIssue } from './errors.ts'

/** The configuration name of clipact's own file, `clipact.json`, in the CLI's folder. */
export const CLIPACT_FILE = 'clipact'

/** File system error codes that mean the CLI's folder or a file in it cannot be written. */
const UNWRITABLE_CODES = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOSPC',
  'EDQUOT',
  'ENOTDIR',
  'EISDIR',
])

/**
 * Returns the platform's default folder for a CLI, or `undefined` when the
 * environment names no home directory: `~/Library/Application Support/<name>`
 * on macOS, `%LOCALAPPDATA%\<name>` on Windows, and `$XDG_DATA_HOME/<name>`
 * (default `~/.local/share/<name>`) elsewhere. A relative `XDG_DATA_HOME` is
 * ignored, as the XDG specification requires.
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#runtime-services
 */
export function defaultDir(
  name: string,
  env: Env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, name) : undefined
  }
  if (platform === 'darwin') {
    return env.HOME
      ? join(env.HOME, 'Library', 'Application Support', name)
      : undefined
  }
  const data = xdgDataHome(env, platform)
  if (data) {
    return join(data, name)
  }
  return env.HOME ? join(env.HOME, '.local', 'share', name) : undefined
}

/**
 * Returns `XDG_DATA_HOME` when it decides the default folder: outside macOS
 * and Windows, and only when it is absolute.
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 */
function xdgDataHome(env: Env, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32' || platform === 'darwin') {
    return undefined
  }
  const value = env.XDG_DATA_HOME
  return value && isAbsolute(value) ? value : undefined
}

/**
 * The CLI's folder for one invocation, what decided it, and the problem with
 * its variable, if any. `dir` is `undefined` when there is no folder or the
 * variable is invalid.
 */
export interface ResolvedDir extends StorageStatus {
  issues: InputIssue[]
}

/**
 * Resolves the CLI's folder: `<PREFIX>_CONFIG_DIR` when it is set, otherwise
 * the platform default. The variable must be an absolute path, so the folder
 * never depends on the working directory; an empty value counts as unset.
 * Touches no file.
 */
export function resolveDir(
  name: string,
  variable: string,
  env: Env,
  platform: NodeJS.Platform = process.platform
): ResolvedDir {
  const value = env[variable]
  if (!value) {
    const data = xdgDataHome(env, platform)
    return {
      dir: defaultDir(name, env, platform),
      source: 'default',
      ...(data ? { variable: 'XDG_DATA_HOME' } : {}),
      issues: [],
    }
  }
  if (!isAbsolute(value)) {
    return {
      dir: undefined,
      source: 'env',
      variable,
      issues: [
        {
          path: variable,
          source: `env:${variable}`,
          message: 'Expected an absolute path',
        },
      ],
    }
  }
  return { dir: value, source: 'env', variable, issues: [] }
}

/**
 * Creates a folder and its parents, giving a folder it creates mode `0700`,
 * since it may hold credentials. An existing folder keeps its mode.
 */
export async function ensureDir(dir: string): Promise<void> {
  // Loaded on use, so commands that never store anything never pay for node:fs.
  const { mkdir } = process.getBuiltinModule('node:fs/promises')
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** Builds the `state_unwritable` error for a path in the CLI's folder. */
export function unwritable(path: string, cause?: unknown): CliError {
  return new CliError({
    code: 'state_unwritable',
    message: `Cannot write ${path}.`,
    retryable: false,
    details: { path },
    cause,
  })
}

/** Builds the `state_unwritable` error for a CLI without a folder. */
export function noDir(variable: string): CliError {
  return new CliError({
    code: 'state_unwritable',
    message: `Cannot find a folder for this CLI's files: set ${variable} or ${process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME'}.`,
    retryable: false,
    details: {},
  })
}

/**
 * Translates an error from the CLI's folder into a {@link CliError}: an
 * iso-conf `ConfError` for an invalid file becomes `config_invalid`, one for
 * a lock held too long becomes `timeout`, and a file system error on a path
 * in `dir` becomes `state_unwritable`. Returns `undefined` for anything else.
 *
 * @see https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf#errors
 */
export function storageError(
  error: unknown,
  dir: string | undefined
): CliError | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }
  const { code, path } = error as { code?: unknown; path?: unknown }
  if (typeof path !== 'string') {
    return undefined
  }
  if (error.name === 'ConfError') {
    if (code === 'ERR_CONF_PARSE' || code === 'ERR_CONF_SCHEMA') {
      return new CliError({
        code: 'config_invalid',
        message: `${path} is invalid: ${error.message}`,
        retryable: false,
        details: { path },
        cause: error,
        next: [{ by: 'user', description: `Fix or remove ${path}` }],
      })
    }
    if (code === 'ERR_CONF_LOCKED') {
      return new CliError({
        code: 'timeout',
        message: `Timed out waiting for another process to finish writing ${path}.`,
        cause: error,
      })
    }
    return undefined
  }
  if (
    dir &&
    typeof code === 'string' &&
    UNWRITABLE_CODES.has(code) &&
    !relative(dir, path).startsWith('..')
  ) {
    return unwritable(path, error)
  }
  return undefined
}

/** Access to the CLI's folder from a handler context. */
export interface StorageAccess {
  /** The folder, or `undefined` when there is none, and what decided it. */
  status: StorageStatus
  /** The framework variable that overrides it, such as `ACME_CONFIG_DIR`. */
  variable: string
  /** The CLI's store, if it defines one. */
  store: AnyStore | undefined
}

/** The folder of each handler context, keyed by the context. */
const contexts = new WeakMap<object, StorageAccess>()

/** Attaches the CLI's folder to a handler's context. */
export function bindStorage(ctx: object, access: StorageAccess): void {
  contexts.set(ctx, access)
}

/**
 * Returns the CLI's folder for `ctx.dir()`: creates it unless `create` is
 * `false`, and throws `state_unwritable` when there is no folder or it
 * cannot be created.
 */
export async function contextDir(
  access: StorageAccess,
  create = true
): Promise<string> {
  const { status, variable } = access
  const { dir } = status
  if (!dir) {
    throw noDir(variable)
  }
  if (create) {
    try {
      await ensureDir(dir)
    } catch (error) {
      throw unwritable(dir, error)
    }
  }
  return dir
}

/** The `defaults` option of an iso-conf store for a schema. */
type DefaultsOf<S extends StandardSchemaV1> = NonNullable<
  ConstructorParameters<typeof Conf<S>>[0]
>['defaults']

/**
 * Options for {@link defineStore}.
 *
 * @see https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf
 */
export interface StoreOptions<S extends StandardSchemaV1> {
  /** A Standard Schema for the whole file, such as a zod object. */
  schema: S
  /** Values for top-level keys missing from the file; required for required fields without a schema default. */
  defaults?: DefaultsOf<S>
  /** The file name without `.json`; defaults to `config`. `clipact`, in any case, is reserved. */
  name?: string
}

/** A store created by {@link defineStore}: one JSON file in the CLI's folder. */
export interface Store<S extends StandardSchemaV1 = StandardSchemaV1>
  extends Readonly<StoreOptions<S>> {
  readonly kind: 'store'
  /**
   * Opens the store for a handler's context. Creates the CLI's folder with
   * mode `0700` when it can, and loads iso-conf on first use. Reading never
   * writes; each write is atomic and holds a lock against other processes.
   */
  get(ctx: AnyContext): Promise<Conf<S>>
}

/** Any store, regardless of its schema. */
// biome-ignore lint/suspicious/noExplicitAny: variance of the schema type
export type AnyStore = Store<any>

// biome-ignore lint/suspicious/noExplicitAny: any handler's context
type AnyContext = Context<any, any>

/** The opened store of each handler context. */
const opened = new WeakMap<object, Promise<Conf<StandardSchemaV1>>>()

/**
 * Defines the CLI's store: one JSON file in the CLI's folder, read and
 * written with iso-conf. Pass the result to `defineCli({ store })`, and open
 * it in a handler with `await store.get(ctx)`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#runtime-services
 * @see https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf
 */
export function defineStore<S extends StandardSchemaV1>(
  options: StoreOptions<S>
): Store<S> {
  const name = options.name ?? 'config'
  // Compared without case, because macOS and Windows file systems ignore it.
  if (name.toLowerCase() === CLIPACT_FILE) {
    throw new TypeError(`Store name "${name}" is reserved for clipact`)
  }
  const store: Store<S> = Object.freeze({
    kind: 'store',
    ...options,
    name,
    get(ctx: AnyContext): Promise<Conf<S>> {
      const access = contexts.get(ctx)
      if (access?.store !== store) {
        return Promise.reject(
          new TypeError(
            'store.get() needs the context of a CLI defined with this store'
          )
        )
      }
      let conf = opened.get(ctx)
      if (!conf) {
        conf = open(store, access as StorageAccess)
        opened.set(ctx, conf)
      }
      return conf as Promise<Conf<S>>
    },
  })
  return store
}

/** Opens a store's file, creating the folder when it can. */
async function open<S extends StandardSchemaV1>(
  store: Store<S>,
  access: StorageAccess
): Promise<Conf<S>> {
  const dir = await contextDir(access, false)
  try {
    await ensureDir(dir)
  } catch {
    // Reads work without the folder; a write then fails with state_unwritable.
  }
  const { Conf } = await import('iso-conf')
  const options = {
    cwd: dir,
    configName: store.name,
    schema: store.schema,
    lock: true,
    ...(store.defaults === undefined ? {} : { defaults: store.defaults }),
  }
  return new Conf<S>(options as ConstructorParameters<typeof Conf<S>>[0])
}
