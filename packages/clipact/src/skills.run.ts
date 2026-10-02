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
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** An installed copy of a skill, as found on disk. */
interface Copy {
  name: string
  target: Target
  path: string
  /** Regular files on disk, as `/`-separated relative paths. */
  files: string[]
  /**
   * Symbolic links inside the copy, or the copy's path when it resolves
   * outside its scope's base directory. The CLI never writes through them.
   */
  links: string[]
  /** Present only when this CLI installed the copy and it has no links. */
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
}

/** Converts the `skills` option to a path. */
function sourcePath(source: URL | string): string {
  return typeof source === 'string' && !source.startsWith('file:')
    ? source
    : fileURLToPath(source)
}

/** Returns the directory a scope installs under: the current or home directory. */
function scopeBase(scope: Scope): string {
  return scope === 'global' ? homedir() : process.cwd()
}

/** Returns the skills directory of a scope and target, such as `./.claude/skills`. */
function skillsRoot(scope: Scope, target: Target): string {
  return join(scopeBase(scope), `.${target}`, 'skills')
}

/** Returns `true` for a missing-file error. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
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
async function hashFile(path: string): Promise<string | undefined> {
  try {
    return hash(await readFile(path))
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Lists the regular files and symbolic links below `dir` as sorted
 * `/`-separated paths, without following links; empty when it does not exist.
 */
async function scan(
  dir: string
): Promise<{ files: string[]; links: string[] }> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
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
  } catch (error) {
    if (isMissing(error)) {
      return { files: [], links: [] }
    }
    throw error
  }
}

/**
 * Returns `true` when `path`, or its nearest existing ancestor, resolves
 * inside `base` after following symbolic links, so a linked `.claude` cannot
 * redirect writes and deletions elsewhere.
 */
async function staysInside(base: string, path: string): Promise<boolean> {
  const root = await realpath(base)
  let current = path
  for (;;) {
    try {
      const real = await realpath(current)
      return real === root || real.startsWith(`${root}${sep}`)
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
      const parent = dirname(current)
      if (parent === current) {
        return false
      }
      current = parent
    }
  }
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
  let text: string
  try {
    text = await readFile(join(path, MANIFEST), 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
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

/** Inspects the copy of a skill in one skills directory. */
async function inspect(
  cli: CliOptions,
  scope: Scope,
  target: Target,
  name: string
): Promise<Copy> {
  const path = join(skillsRoot(scope, target), name)
  const found = await scan(path)
  const links = found.links.map((link) => join(path, link))
  if (!(await staysInside(scopeBase(scope), path))) {
    links.unshift(path)
  }
  const manifest =
    links.length > 0 ? undefined : await readManifest(path, cli.name)
  const listed = Object.entries(manifest?.files ?? {})
  const hashes = await Promise.all(
    listed.map(([file]) => hashFile(join(path, file)))
  )
  const edited = listed
    .filter(([, expected], index) => hashes[index] !== expected)
    .map(([file]) => file)
  return { name, target, path, files: found.files, links, manifest, edited }
}

/** Inspects every skill in each selected skills directory, in installation order. */
function inspectAll<T extends { name: string }>(
  cli: CliOptions,
  scope: Scope,
  targets: readonly Target[],
  skills: readonly T[]
): Promise<[T, Copy][]> {
  return Promise.all(
    TARGETS.filter((target) => targets.includes(target)).flatMap((target) =>
      skills.map(
        async (skill): Promise<[T, Copy]> => [
          skill,
          await inspect(cli, scope, target, skill.name),
        ]
      )
    )
  )
}

/** Classifies a copy against the bundle it would be installed from. */
function stateOf(cli: CliOptions, copy: Copy, bundle: Bundle): State {
  if (copy.links.length > 0) {
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
  const base = { name: copy.name, target: copy.target, path: copy.path }
  if (state === 'symlink') {
    return { ...base, reason: 'symlink', files: copy.links }
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
  const files: Record<string, string> = {}
  for (const [file, { content, mode, hash }] of bundle.files) {
    const path = join(copy.path, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    await chmod(path, mode)
    files[file] = hash
  }
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

/** Returns the flags that repeat a scope and target selection on a command line. */
function selection(scope: Scope, targets: readonly Target[]): string {
  const flags = scope === 'global' ? ' --scope global' : ''
  return targets.length === TARGETS.length
    ? flags
    : `${flags}${targets.map((target) => ` --target ${target}`).join('')}`
}

/**
 * Creates the `skills install` handler: copies each bundled skill into the
 * selected skills directories, refusing to replace edited or unmanaged
 * copies without `--force`.
 */
export function install(
  cli: CliOptions,
  source: URL | string,
  command: InstallCommand
): Handler {
  return defineHandler(command, async (ctx) => {
    const { scope, target: targets, force } = ctx.input
    const bundles = await readBundles(sourcePath(source))
    const copies = (await inspectAll(cli, scope, targets, bundles)).map(
      ([bundle, copy]) => ({ bundle, copy, state: stateOf(cli, copy, bundle) })
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
      if (conflicts.some((conflict) => conflict.reason === 'symlink')) {
        next.push({
          by: 'user',
          description:
            'Remove the symbolic links from these skill directories; install never writes through them',
        })
      }
      if (conflicts.some((conflict) => conflict.reason !== 'symlink')) {
        next.push({
          by: 'user',
          command: `${cli.name} skills install${selection(scope, targets)} --force`,
          description: 'Replace them, discarding local changes',
        })
      }
      throw new CliError({
        code: 'skill_conflict',
        message: `Not replacing skill directories with local changes, symbolic links, or files not installed by ${cli.name}: ${conflicts.map((conflict) => conflict.path).join(', ')}.`,
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
      skills.push({
        name: copy.name,
        target: copy.target,
        path: copy.path,
        action,
      })
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
  source: URL | string,
  command: UninstallCommand
): Handler {
  return defineHandler(command, async (ctx) => {
    const { scope, target: targets } = ctx.input
    const names = (await bundleNames(sourcePath(source))).map((name) => ({
      name,
    }))
    const skills: RemovedCopy[] = []
    for (const [, copy] of await inspectAll(cli, scope, targets, names)) {
      const base = { name: copy.name, target: copy.target, path: copy.path }
      if (!copy.manifest) {
        const missing = copy.files.length === 0 && copy.links.length === 0
        skills.push({ ...base, action: missing ? 'missing' : 'unmanaged' })
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
  source: URL | string,
  command: StatusCommand
): Handler {
  return defineHandler(command, async (ctx) => {
    const scopes: Scope[] = ctx.input.scope
      ? [ctx.input.scope]
      : ['project', 'global']
    const bundles = await readBundles(sourcePath(source))
    const skills: CopyStatus[] = []
    for (const scope of scopes) {
      for (const [bundle, copy] of await inspectAll(
        cli,
        scope,
        TARGETS,
        bundles
      )) {
        skills.push({
          name: copy.name,
          scope,
          target: copy.target,
          path: copy.path,
          status: stateOf(cli, copy, bundle),
          ...(copy.manifest ? { version: copy.manifest.version } : {}),
        })
      }
    }
    const next: Next[] = []
    for (const scope of scopes) {
      if (
        skills.some((copy) => copy.scope === scope && copy.status === 'stale')
      ) {
        next.push({
          by: 'agent',
          command: `${cli.name} skills install${selection(scope, TARGETS)}`,
          description: `Update the ${scope} skills to this version`,
        })
      }
    }
    if (skills.every((copy) => copy.status === 'missing')) {
      next.push({
        by: 'agent',
        command: `${cli.name} skills install`,
        description: 'Install the skills for this project',
      })
    }
    return ctx.ok({ version: cli.version, skills }, { next })
  })
}

/**
 * Returns a notice for project skills installed by another CLI version, or
 * `undefined`. Compares only manifest versions, so it stays cheap enough to
 * run after every human-mode command.
 */
export async function staleNotice(
  cli: CliOptions,
  source: URL | string
): Promise<string | undefined> {
  const names = await bundleNames(sourcePath(source))
  const found = await Promise.all(
    names.flatMap((name) =>
      TARGETS.map(async (target) => ({
        name,
        manifest: await readManifest(
          join(skillsRoot('project', target), name),
          cli.name
        ),
      }))
    )
  )
  const stale = new Map<string, string>()
  for (const { name, manifest } of found) {
    if (manifest && manifest.version !== cli.version) {
      stale.set(name, manifest.version)
    }
  }
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
