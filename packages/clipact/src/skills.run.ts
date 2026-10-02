import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
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

/** A skill directory shipped with the CLI. */
interface Bundle {
  name: string
  files: Map<string, Buffer>
  hashes: Record<string, string>
}

/** An installed copy of a skill, as found on disk. */
interface Copy {
  name: string
  target: Target
  path: string
  exists: boolean
  /** Present only when this CLI installed the copy. */
  manifest: Manifest | undefined
  /** Installed files that were changed or deleted since. */
  edited: string[]
}

/** Converts the `skills` option to a path. */
function sourcePath(source: URL | string): string {
  return typeof source === 'string' && !source.startsWith('file:')
    ? source
    : fileURLToPath(source)
}

/** Returns the skills directory of a scope and target, such as `./.claude/skills`. */
function skillsRoot(scope: Scope, target: Target): string {
  const base = scope === 'global' ? homedir() : process.cwd()
  return join(base, `.${target}`, 'skills')
}

/** Returns `true` for a missing-file error. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Returns the SHA-256 of a file's content. */
function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Lists regular files below `dir` as sorted `/`-separated paths; empty when it does not exist. */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')
      )
      .sort()
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
}

/** Lists the names of the directories in `source` that contain a `SKILL.md`. */
async function bundleNames(source: string): Promise<string[]> {
  const names: string[] = []
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      try {
        await access(join(source, entry.name, 'SKILL.md'))
        names.push(entry.name)
      } catch {
        // Not a skill directory.
      }
    }
  }
  return names.sort()
}

/** Reads every skill directory in `source` that contains a `SKILL.md`. */
async function readBundles(source: string): Promise<Bundle[]> {
  const bundles: Bundle[] = []
  for (const name of await bundleNames(source)) {
    const dir = join(source, name)
    const paths = (await listFiles(dir)).filter((path) => path !== MANIFEST)
    const files = new Map<string, Buffer>()
    const hashes: Record<string, string> = {}
    for (const path of paths) {
      const content = await readFile(join(dir, path))
      files.set(path, content)
      hashes[path] = hash(content)
    }
    bundles.push({ name, files, hashes })
  }
  if (bundles.length === 0) {
    throw new Error(`No skills with a SKILL.md found in ${source}`)
  }
  return bundles
}

/** Reads a copy's manifest; `undefined` when absent, invalid, or written by another CLI. */
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
    return manifest.cli === cli &&
      typeof manifest.version === 'string' &&
      typeof manifest.files === 'object' &&
      manifest.files !== null
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
  const manifest = await readManifest(path, cli.name)
  const edited: string[] = []
  for (const [file, expected] of Object.entries(manifest?.files ?? {})) {
    try {
      if (hash(await readFile(join(path, file))) !== expected) {
        edited.push(file)
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
      edited.push(file)
    }
  }
  const exists = manifest !== undefined || (await listFiles(path)).length > 0
  return { name, target, path, exists, manifest, edited }
}

/** `true` when a copy was installed by this CLI version from this bundle, unedited. */
function isCurrent(cli: CliOptions, copy: Copy, bundle: Bundle): boolean {
  const installed = copy.manifest?.files ?? {}
  return (
    copy.manifest?.version === cli.version &&
    copy.edited.length === 0 &&
    Object.keys(installed).length === bundle.files.size &&
    Object.entries(bundle.hashes).every(
      ([file, digest]) => installed[file] === digest
    )
  )
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

/** Writes a bundle into a copy, removes files the previous version installed, and records the manifest. */
async function write(cli: CliOptions, copy: Copy, bundle: Bundle) {
  for (const [file, content] of bundle.files) {
    const path = join(copy.path, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  for (const file of Object.keys(copy.manifest?.files ?? {})) {
    if (!bundle.files.has(file)) {
      await removeFile(copy.path, file)
    }
  }
  const manifest: Manifest = {
    cli: cli.name,
    version: cli.version,
    files: bundle.hashes,
  }
  await writeFile(
    join(copy.path, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

/** Returns the flags that repeat a scope and target selection on a command line. */
function selection(scope: Scope, targets: Target[]): string {
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
    const pairs: { bundle: Bundle; copy: Copy }[] = []
    for (const target of TARGETS.filter((name) => targets.includes(name))) {
      for (const bundle of bundles) {
        pairs.push({
          bundle,
          copy: await inspect(cli, scope, target, bundle.name),
        })
      }
    }
    const conflicts = force
      ? []
      : pairs
          .map(({ copy }) => copy)
          .filter(
            (copy) => copy.exists && (!copy.manifest || copy.edited.length > 0)
          )
    if (conflicts.length > 0) {
      throw new CliError({
        code: 'skill_conflict',
        message: `Not replacing skill directories that were edited or not installed by ${cli.name}: ${conflicts.map((copy) => copy.path).join(', ')}.`,
        retryable: false,
        details: conflicts.map((copy) => ({
          name: copy.name,
          target: copy.target,
          path: copy.path,
          reason: copy.manifest ? 'edited' : 'unmanaged',
          ...(copy.manifest ? { files: copy.edited } : {}),
        })),
        next: [
          {
            by: 'user',
            command: `${cli.name} skills install${selection(scope, targets)} --force`,
            description: 'Replace them, discarding local changes',
          },
        ],
      })
    }
    const skills: InstalledCopy[] = []
    for (const { bundle, copy } of pairs) {
      const action = copy.exists
        ? isCurrent(cli, copy, bundle)
          ? 'unchanged'
          : 'updated'
        : 'installed'
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
    const names = await bundleNames(sourcePath(source))
    const skills: RemovedCopy[] = []
    for (const target of TARGETS.filter((name) => targets.includes(name))) {
      for (const name of names) {
        const copy = await inspect(cli, scope, target, name)
        const base = { name, target, path: copy.path }
        if (!copy.exists) {
          skills.push({ ...base, action: 'missing' })
          continue
        }
        if (!copy.manifest) {
          skills.push({ ...base, action: 'unmanaged' })
          continue
        }
        const remove = Object.keys(copy.manifest.files).filter(
          (file) => !copy.edited.includes(file)
        )
        const kept = (await listFiles(copy.path)).filter(
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
      for (const target of TARGETS) {
        for (const bundle of bundles) {
          const copy = await inspect(cli, scope, target, bundle.name)
          skills.push({
            name: copy.name,
            scope,
            target,
            path: copy.path,
            status: copy.exists
              ? copy.manifest
                ? copy.edited.length > 0
                  ? 'edited'
                  : isCurrent(cli, copy, bundle)
                    ? 'current'
                    : 'stale'
                : 'unmanaged'
              : 'missing',
            ...(copy.manifest ? { version: copy.manifest.version } : {}),
          })
        }
      }
    }
    const next: Next[] = []
    for (const scope of scopes) {
      if (
        skills.some((copy) => copy.scope === scope && copy.status === 'stale')
      ) {
        next.push({
          by: 'agent',
          command: `${cli.name} skills install${selection(scope, [...TARGETS])}`,
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
  const stale = new Map<string, string>()
  for (const name of await bundleNames(sourcePath(source))) {
    for (const target of TARGETS) {
      const manifest = await readManifest(
        join(skillsRoot('project', target), name),
        cli.name
      )
      if (manifest && manifest.version !== cli.version) {
        stale.set(name, manifest.version)
      }
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
