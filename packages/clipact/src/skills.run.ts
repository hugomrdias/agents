import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { type CliOptions, defineHandler, type Handler } from './define.ts'
import { CliError, type Next } from './errors.ts'
import {
  type CopyStatus,
  type InstallCommand,
  type InstalledCopy,
  type RemovedCopy,
  type Scope,
  type StatusCommand,
  TARGETS,
  type Target,
  type UninstallCommand,
} from './skills.ts'

/** The file in each installed skill directory that records what the CLI wrote. */
export const MANIFEST = '.clipact.json'

/** Contents of {@link MANIFEST}. */
interface Manifest {
  cli: string
  version: string
  /** SHA-256 of each installed file, by `/`-separated relative path. */
  files: Record<string, string>
}

/** A file shipped in a skill directory. */
interface BundleFile {
  content: Buffer
  /** Permission bits, so shipped scripts stay executable. */
  mode: number
  hash: string
}

/** A skill directory shipped with the CLI. */
interface Bundle {
  name: string
  files: Map<string, BundleFile>
}

/** What is on disk at a copy's path, without reading its contents. */
interface Location {
  /** Regular files on disk, as `/`-separated relative paths. */
  files: string[]
  /** Symbolic links inside the copy. The CLI never writes through them. */
  links: string[]
  /** Where the copy's path resolves when that is outside its scope's base directory. */
  resolvesTo: string | undefined
}

/** An installed copy of a skill, as found on disk. */
interface Copy extends Location {
  name: string
  target: Target
  path: string
  /** Present only when this CLI installed the copy and it is not {@link isLinked}. */
  manifest: Manifest | undefined
  /** Installed files that were changed or deleted since. */
  edited: string[]
}

/** What a copy is relative to the bundle it would be installed from. */
type State = CopyStatus['status']

/** Why `install` will not write a copy. */
interface Conflict {
  name: string
  target: Target
  path: string
  reason: 'edited' | 'unmanaged' | 'symlink'
  files?: string[]
  /** Where the copy's path resolves, for a linked `.claude` or `.agents` outside the scope. */
  resolvesTo?: string
}

/** Returns the directory a scope installs under: the current or home directory. */
function scopeBase(scope: Scope): string {
  return scope === 'global' ? homedir() : process.cwd()
}

/** Names a scope's base directory for messages. */
function scopeBaseName(scope: Scope): string {
  return scope === 'global' ? 'home directory' : 'current directory'
}

/** Returns the skills directory of a scope and target, such as `./.claude/skills`. */
function skillsRoot(scope: Scope, target: Target): string {
  return join(scopeBase(scope), `.${target}`, 'skills')
}

/** Returns `true` for a missing-file error. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Creates a rejection handler that returns `fallback` for a missing file and rethrows anything else. */
function unlessMissing<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (isMissing(error)) {
      return fallback
    }
    throw error
  }
}

/** Returns the identity of a copy as reported by every command. */
function where(copy: Copy): Pick<Copy, 'name' | 'target' | 'path'> {
  return { name: copy.name, target: copy.target, path: copy.path }
}

/**
 * Returns the SHA-256 of a file's content. Loads `node:crypto` on first use,
 * so the stale-skill notice never pays for it.
 */
function hash(content: Buffer): string {
  const { createHash } = process.getBuiltinModule('node:crypto')
  return createHash('sha256').update(content).digest('hex')
}

/** Returns the SHA-256 of a file, or `undefined` when it does not exist. */
function hashFile(path: string): Promise<string | undefined> {
  return readFile(path).then(hash, unlessMissing(undefined))
}

/**
 * Lists the regular files and symbolic links below `dir` as sorted
 * `/`-separated paths, without following links; empty when it does not exist.
 */
async function scan(
  dir: string
): Promise<{ files: string[]; links: string[] }> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(unlessMissing([]))
  const paths = (keep: (entry: (typeof entries)[number]) => boolean) =>
    entries
      .filter(keep)
      .map((entry) =>
        relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')
      )
      .sort()
  return {
    files: paths((entry) => entry.isFile()),
    links: paths((entry) => entry.isSymbolicLink()),
  }
}

/**
 * Resolves the symbolic links in `path`, or in its nearest existing ancestor
 * followed by the segments that do not exist yet.
 */
async function resolveExisting(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
    const parent = dirname(path)
    return parent === path
      ? path
      : join(await resolveExisting(parent), basename(path))
  }
}

/** Returns `true` when `path`, an already resolved path, is `root` or below it. */
function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

/**
 * Returns `true` for a manifest entry that names a file inside its copy: a
 * relative `/`-separated path without empty, `.`, or `..` segments.
 */
function isSafePath(file: string): boolean {
  return (
    file !== MANIFEST &&
    !/[\\\0]/.test(file) &&
    file
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

/** Lists the names of the directories in `source` that contain a `SKILL.md`. */
async function bundleNames(source: string): Promise<string[]> {
  const entries = await readdir(source, { withFileTypes: true })
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(({ name }) =>
        access(join(source, name, 'SKILL.md')).then(
          () => name,
          () => undefined
        )
      )
  )
  return names.filter((name) => name !== undefined).sort()
}

/** Reads every skill directory in `source` that contains a `SKILL.md`. */
async function readBundles(source: string): Promise<Bundle[]> {
  const names = await bundleNames(source)
  if (names.length === 0) {
    throw new Error(`No skills with a SKILL.md found in ${source}`)
  }
  return await Promise.all(
    names.map(async (name) => {
      const dir = join(source, name)
      const paths = (await scan(dir)).files.filter((path) => path !== MANIFEST)
      const files = await Promise.all(
        paths.map(async (path): Promise<[string, BundleFile]> => {
          const [content, info] = await Promise.all([
            readFile(join(dir, path)),
            stat(join(dir, path)),
          ])
          return [
            path,
            { content, mode: info.mode & 0o777, hash: hash(content) },
          ]
        })
      )
      return { name, files: new Map(files) }
    })
  )
}

/**
 * Reads a copy's manifest; `undefined` when absent, invalid, written by
 * another CLI, or listing a path outside the copy.
 */
async function readManifest(
  path: string,
  cli: string
): Promise<Manifest | undefined> {
  const text = await readFile(join(path, MANIFEST), 'utf8').catch(
    unlessMissing(undefined)
  )
  if (text === undefined) {
    return undefined
  }
  try {
    const manifest = JSON.parse(text) as Manifest
    const files: unknown = manifest?.files
    return manifest.cli === cli &&
      typeof manifest.version === 'string' &&
      typeof files === 'object' &&
      files !== null &&
      !Array.isArray(files) &&
      Object.entries(files).every(
        ([file, digest]) => isSafePath(file) && typeof digest === 'string'
      )
      ? manifest
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Lists a copy's files and links, and where it resolves when that is outside
 * `base`, the scope's resolved directory, such as through a linked `.claude`.
 */
async function locate(base: string, path: string): Promise<Location> {
  const [found, real] = await Promise.all([scan(path), resolveExisting(path)])
  return {
    files: found.files,
    links: found.links.map((link) => join(path, link)),
    resolvesTo: isInside(base, real) ? undefined : real,
  }
}

/**
 * Returns `true` when writing a copy would follow a symbolic link: one inside
 * it, or a linked directory that resolves outside its scope. `install` never
 * writes such a copy, even with `--force`.
 */
function isLinked(location: Location): boolean {
  return location.links.length > 0 || location.resolvesTo !== undefined
}

/** Inspects the copy of a skill in one skills directory; `base` is the scope's resolved directory. */
async function inspect(
  cli: CliOptions,
  scope: Scope,
  base: string,
  target: Target,
  name: string
): Promise<Copy> {
  const path = join(skillsRoot(scope, target), name)
  const location = await locate(base, path)
  const manifest = isLinked(location)
    ? undefined
    : await readManifest(path, cli.name)
  const listed = Object.entries(manifest?.files ?? {})
  const hashes = await Promise.all(
    listed.map(([file]) => hashFile(join(path, file)))
  )
  const edited = listed
    .filter(([, expected], index) => hashes[index] !== expected)
    .map(([file]) => file)
  return { name, target, path, ...location, manifest, edited }
}

/** Inspects each named skill in each selected skills directory, in installation order. */
async function inspectAll(
  cli: CliOptions,
  scope: Scope,
  targets: readonly Target[],
  names: readonly string[]
): Promise<Copy[]> {
  const base = await realpath(scopeBase(scope))
  return await Promise.all(
    TARGETS.filter((target) => targets.includes(target)).flatMap((target) =>
      names.map((name) => inspect(cli, scope, base, target, name))
    )
  )
}

/** Inspects the copies of each bundle, paired with the bundle. */
async function inspectBundles(
  cli: CliOptions,
  scope: Scope,
  targets: readonly Target[],
  bundles: readonly Bundle[]
): Promise<{ bundle: Bundle; copy: Copy }[]> {
  const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]))
  const copies = await inspectAll(cli, scope, targets, [...byName.keys()])
  return copies.map((copy) => ({
    bundle: byName.get(copy.name) as Bundle,
    copy,
  }))
}

/** Classifies a copy against the bundle it would be installed from. */
function stateOf(cli: CliOptions, copy: Copy, bundle: Bundle): State {
  if (isLinked(copy)) {
    return 'symlink'
  }
  if (!copy.manifest) {
    return copy.files.length > 0 ? 'unmanaged' : 'missing'
  }
  if (copy.edited.length > 0) {
    return 'edited'
  }
  const installed = copy.manifest.files
  const current =
    copy.manifest.version === cli.version &&
    Object.keys(installed).length === bundle.files.size &&
    [...bundle.files].every(([file, { hash }]) => installed[file] === hash)
  return current ? 'current' : 'stale'
}

/** Lists files the manifest does not list that the bundle would replace with different content. */
async function overwrites(copy: Copy, bundle: Bundle): Promise<string[]> {
  const listed = copy.manifest?.files ?? {}
  const local = copy.files.filter(
    (file) => !(file in listed) && bundle.files.has(file)
  )
  const hashes = await Promise.all(
    local.map((file) => hashFile(join(copy.path, file)))
  )
  return local.filter(
    (file, index) => hashes[index] !== bundle.files.get(file)?.hash
  )
}

/**
 * Returns why `install` must not write a copy: symbolic links always; without
 * `--force`, a copy this CLI did not install, edited files, or local files
 * the bundle would overwrite.
 */
async function conflictOf(
  copy: Copy,
  bundle: Bundle,
  state: State,
  force: boolean
): Promise<Conflict | undefined> {
  const base = where(copy)
  if (state === 'symlink') {
    return {
      ...base,
      reason: 'symlink',
      ...(copy.resolvesTo
        ? { files: [copy.path, ...copy.links], resolvesTo: copy.resolvesTo }
        : { files: copy.links }),
    }
  }
  if (force || state === 'missing') {
    return undefined
  }
  if (state === 'unmanaged') {
    return { ...base, reason: 'unmanaged' }
  }
  const files = [...copy.edited, ...(await overwrites(copy, bundle))].sort()
  return files.length > 0 ? { ...base, reason: 'edited', files } : undefined
}

/** Removes a file, then any directories it leaves empty below `root`. */
async function removeFile(root: string, file: string): Promise<void> {
  await rm(join(root, file), { force: true })
  let dir = dirname(join(root, file))
  while (dir.startsWith(`${root}${sep}`)) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/**
 * Writes a bundle into a copy with its file modes, removes unedited files the
 * previous version installed, and records the manifest.
 */
async function write(cli: CliOptions, copy: Copy, bundle: Bundle) {
  const paths = [...bundle.files.keys()].map((file) => join(copy.path, file))
  await Promise.all(
    [...new Set(paths.map((path) => dirname(path)))].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  )
  await Promise.all(
    [...bundle.files.values()].map(async ({ content, mode }, index) => {
      const path = paths[index] as string
      // Replace rather than overwrite: a previous copy of a read-only file
      // cannot be opened for writing.
      await rm(path, { force: true })
      await writeFile(path, content)
      await chmod(path, mode)
    })
  )
  const files = Object.fromEntries(
    [...bundle.files].map(([file, { hash }]) => [file, hash])
  )
  for (const file of Object.keys(copy.manifest?.files ?? {})) {
    if (!(bundle.files.has(file) || copy.edited.includes(file))) {
      await removeFile(copy.path, file)
    }
  }
  const manifest: Manifest = { cli: cli.name, version: cli.version, files }
  await writeFile(
    join(copy.path, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

/** Returns the `skills install` command line for a scope and target selection. */
function installCommand(
  cli: CliOptions,
  scope: Scope,
  targets: readonly Target[]
): string {
  const flags = [
    ...(scope === 'global' ? ['--scope global'] : []),
    ...(targets.length === TARGETS.length
      ? []
      : targets.map((target) => `--target ${target}`)),
  ]
  return [cli.name, 'skills', 'install', ...flags].join(' ')
}

/**
 * Creates the `skills install` handler: copies each bundled skill into the
 * selected skills directories, refusing to replace edited or unmanaged
 * copies without `--force`.
 */
export function install(
  cli: CliOptions,
  source: string,
  command: InstallCommand
): Handler {
  return defineHandler(command, async (ctx) => {
    const { scope, target: targets, force } = ctx.input
    const bundles = await readBundles(source)
    const copies = (await inspectBundles(cli, scope, targets, bundles)).map(
      ({ bundle, copy }) => ({
        bundle,
        copy,
        state: stateOf(cli, copy, bundle),
      })
    )
    const conflicts = (
      await Promise.all(
        copies.map(({ bundle, copy, state }) =>
          conflictOf(copy, bundle, state, force)
        )
      )
    ).filter((conflict) => conflict !== undefined)
    if (conflicts.length > 0) {
      const next: Next[] = []
      const outside = conflicts.filter((conflict) => conflict.resolvesTo)
      const base = scopeBaseName(scope)
      if (copies.some(({ copy }) => copy.links.length > 0)) {
        next.push({
          by: 'user',
          description:
            'Remove the symbolic links inside these skill directories; install never writes through them',
        })
      }
      if (outside.length > 0) {
        const other: Scope = scope === 'global' ? 'project' : 'global'
        next.push(
          {
            by: 'user',
            description: `Copy the skills by hand from ${source}, or replace the linked directory with a real one; install never writes outside the ${base}`,
          },
          {
            by: 'user',
            command: installCommand(cli, other, targets),
            description: `Install into the ${other} scope instead`,
          }
        )
      }
      if (conflicts.some((conflict) => conflict.reason !== 'symlink')) {
        next.push({
          by: 'user',
          command: `${installCommand(cli, scope, targets)} --force`,
          description: 'Replace them, discarding local changes',
        })
      }
      const paths = conflicts.map((conflict) => conflict.path).join(', ')
      const resolved = outside
        .map(
          (conflict) =>
            ` ${conflict.path} resolves to ${conflict.resolvesTo}, outside the ${base}.`
        )
        .join('')
      throw new CliError({
        code: 'skill_conflict',
        message: `Not replacing skill directories with local changes, symbolic links, or files not installed by ${cli.name}: ${paths}.${resolved}`,
        retryable: false,
        details: conflicts,
        next,
      })
    }
    const skills: InstalledCopy[] = []
    for (const { bundle, copy, state } of copies) {
      const action =
        state === 'missing'
          ? 'installed'
          : state === 'current'
            ? 'unchanged'
            : 'updated'
      if (action !== 'unchanged' && !ctx.dryRun) {
        await write(cli, copy, bundle)
      }
      skills.push({ ...where(copy), action })
    }
    return ctx.ok({ scope, skills })
  })
}

/**
 * Creates the `skills uninstall` handler: removes the files this CLI
 * installed and nobody edited, and keeps everything else.
 */
export function uninstall(
  cli: CliOptions,
  source: string,
  command: UninstallCommand
): Handler {
  return defineHandler(command, async (ctx) => {
    const { scope, target: targets } = ctx.input
    const names = await bundleNames(source)
    const skills: RemovedCopy[] = []
    for (const copy of await inspectAll(cli, scope, targets, names)) {
      const base = where(copy)
      if (!copy.manifest) {
        let action: RemovedCopy['action'] = 'unmanaged'
        if (copy.files.length === 0 && copy.links.length === 0) {
          action = 'missing'
        } else if (isLinked(copy)) {
          action = 'symlink'
        }
        skills.push({ ...base, action })
        continue
      }
      const remove = Object.keys(copy.manifest.files).filter(
        (file) => !copy.edited.includes(file)
      )
      const kept = copy.files.filter(
        (file) => file !== MANIFEST && !remove.includes(file)
      )
      if (!ctx.dryRun) {
        for (const file of remove) {
          await removeFile(copy.path, file)
        }
        await rm(join(copy.path, MANIFEST), { force: true })
        await rmdir(copy.path).catch(() => undefined)
      }
      skills.push({
        ...base,
        action: 'removed',
        ...(kept.length > 0 ? { kept } : {}),
      })
    }
    return ctx.ok({ scope, skills })
  })
}

/**
 * Creates the `skills status` handler: reports each copy of each bundled
 * skill in both scopes, or the requested one.
 */
export function status(
  cli: CliOptions,
  source: string,
  command: StatusCommand
): Handler {
  return defineHandler(command, async (ctx) => {
    const scopes: Scope[] = ctx.input.scope
      ? [ctx.input.scope]
      : ['project', 'global']
    const bundles = await readBundles(source)
    const inspected = await Promise.all(
      scopes.map((scope) => inspectBundles(cli, scope, TARGETS, bundles))
    )
    const skills: CopyStatus[] = scopes.flatMap((scope, index) =>
      (inspected[index] ?? []).map(({ bundle, copy }) => ({
        name: copy.name,
        scope,
        target: copy.target,
        path: copy.path,
        status: stateOf(cli, copy, bundle),
        ...(copy.manifest ? { version: copy.manifest.version } : {}),
      }))
    )
    const next: Next[] = []
    for (const scope of scopes) {
      if (
        skills.some((copy) => copy.scope === scope && copy.status === 'stale')
      ) {
        next.push({
          by: 'agent',
          command: installCommand(cli, scope, TARGETS),
          description: `Update the ${scope} skills to this version`,
        })
      }
    }
    if (skills.every((copy) => copy.status === 'missing')) {
      const scope = ctx.input.scope ?? 'project'
      next.push({
        by: 'agent',
        command: installCommand(cli, scope, TARGETS),
        description:
          scope === 'global'
            ? 'Install the skills for every project'
            : 'Install the skills for this project',
      })
    }
    return ctx.ok({ version: cli.version, skills }, { next })
  })
}

/**
 * Returns a notice for project skills installed by another CLI version, or
 * `undefined`. Reads only the manifests of installed directories named like
 * a bundled skill, so it stays cheap enough to run after every human-mode
 * command, and skips {@link isLinked} copies, which `install` never writes.
 */
export async function staleNotice(
  cli: CliOptions,
  source: string
): Promise<string | undefined> {
  const installed = await Promise.all(
    TARGETS.map((target) =>
      readdir(skillsRoot('project', target)).catch(unlessMissing([]))
    )
  )
  // Most projects have none of this CLI's skills; skip reading the bundle then.
  if (installed.every((entries) => entries.length === 0)) {
    return undefined
  }
  const [shipped, base] = await Promise.all([
    bundleNames(source).then((names) => new Set(names)),
    realpath(scopeBase('project')),
  ])
  const found = await Promise.all(
    TARGETS.flatMap((target, index) =>
      (installed[index] ?? [])
        .filter((name) => shipped.has(name))
        .map(async (name): Promise<[string, string] | undefined> => {
          const path = join(skillsRoot('project', target), name)
          const manifest = await readManifest(path, cli.name)
          if (
            !manifest ||
            manifest.version === cli.version ||
            isLinked(await locate(base, path))
          ) {
            return undefined
          }
          return [name, manifest.version]
        })
    )
  )
  const stale = new Map(found.filter((entry) => entry !== undefined))
  if (stale.size === 0) {
    return undefined
  }
  return [...stale]
    .map(
      ([name, version]) =>
        `${cli.name}: the installed "${name}" skill is from version ${version}; run "${cli.name} skills install" to update it.`
    )
    .join('\n')
}
