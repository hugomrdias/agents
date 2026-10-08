import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { parse } from 'yaml'
import { type TarFile, tarGz } from './tar.ts'

/** Schema of the discovery index this package writes. */
export const DISCOVERY_SCHEMA =
  'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

/** A published skill: one entry of the index and the file it points to. */
export interface PublishedSkill {
  /** Skill name, which is also its directory name. */
  name: string
  /** `description` from the `SKILL.md` frontmatter. */
  description: string
  /** `skill-md` for a lone `SKILL.md`, `archive` for a `.tar.gz` of the directory. */
  type: 'skill-md' | 'archive'
  /** Path of the published file relative to the index: `<name>/SKILL.md` or `<name>.tar.gz`. */
  file: string
  /** Content type to serve the file with. */
  contentType: string
  /** SHA-256 of the published bytes, as `sha256:<hex>`. */
  digest: string
  /** Published bytes. */
  bytes: Uint8Array
}

/** One entry of the discovery index. */
export interface DiscoveryEntry {
  name: string
  type: 'skill-md' | 'archive'
  description: string
  /** URL of the published file, relative to the index. */
  url: string
  digest: string
}

/** The discovery index served at `.well-known/agent-skills/index.json`. */
export interface DiscoveryIndex {
  $schema: string
  skills: DiscoveryEntry[]
}

/** Skill names allowed by the Agent Skills specification. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Longest name and description the specification allows. */
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024

/**
 * Archive limits enforced by the `skills` CLI, so every published skill
 * installs with it.
 *
 * @see https://github.com/vercel-labs/skills
 */
const MAX_FILES = 1000
const MAX_BYTES = 50 * 1024 * 1024

/**
 * Read and validate every skill under `dir`, and build its published file.
 * Throws one error that lists every problem found.
 *
 * @param dir - Directory that holds one directory per skill.
 * @returns The published skills, sorted by name, and every file read.
 * @see https://agentskills.io/specification
 */
export async function publishSkills(dir: string) {
  const problems: string[] = []
  const skills: PublishedSkill[] = []
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) {
    problems.push(`${dir} has no skills`)
  }
  for (const name of names) {
    const skill = await readSkill(join(dir, name))
    files.push(...[...skill.files.keys()].map((file) => join(dir, name, file)))
    const result = checkSkill(name, skill.files)
    const skillProblems = [...skill.problems, ...result.problems]
    if (skillProblems.length > 0) {
      problems.push(...skillProblems.map((problem) => `${name}: ${problem}`))
      continue
    }
    skills.push(buildSkill(name, result.description, skill.files))
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid agent skills in ${dir}:\n- ${problems.join('\n- ')}`
    )
  }
  return { skills, files }
}

/**
 * Build the discovery index of published skills, with URLs relative to the
 * index so it works under any base path.
 *
 * @param skills - Published skills.
 * @see https://github.com/cloudflare/agent-skills-discovery-rfc
 */
export function discoveryIndex(
  skills: readonly PublishedSkill[]
): DiscoveryIndex {
  return {
    $schema: DISCOVERY_SCHEMA,
    skills: skills.map((skill) => ({
      name: skill.name,
      type: skill.type,
      description: skill.description,
      url: skill.file,
      digest: skill.digest,
    })),
  }
}

/**
 * Parse the YAML frontmatter of a `SKILL.md` file.
 *
 * @param markdown - Contents of a `SKILL.md` file.
 * @returns The frontmatter fields, or `undefined` when there is none or it
 *   is not a YAML mapping.
 */
export function parseFrontmatter(
  markdown: string
): Record<string, unknown> | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1]
  if (block === undefined) {
    return undefined
  }
  try {
    const fields: unknown = parse(block)
    return fields !== null &&
      typeof fields === 'object' &&
      !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Read every regular file of a skill directory, keyed by `/`-separated
 * relative path. Symbolic links and other special files are problems,
 * because the published files cannot carry them safely.
 *
 * @param skillDir - Skill directory.
 */
async function readSkill(skillDir: string) {
  const files = new Map<string, TarFile>()
  const problems: string[] = []
  const paths = await readdir(skillDir, { recursive: true })
  for (const path of paths.sort()) {
    const full = join(skillDir, path)
    const stats = await lstat(full)
    const file = path.split(sep).join('/')
    if (stats.isSymbolicLink()) {
      problems.push(`${file} is a symbolic link`)
    } else if (stats.isFile()) {
      files.set(file, {
        content: await readFile(full),
        executable: (stats.mode & 0o111) !== 0,
      })
    } else if (!stats.isDirectory()) {
      problems.push(`${file} is not a regular file`)
    }
  }
  return { files, problems }
}

/**
 * Check a skill against the specification and the `skills` CLI limits.
 *
 * @param name - Directory name.
 * @param files - Skill files by relative path.
 * @returns The problems found, and the description when it is valid.
 */
function checkSkill(name: string, files: ReadonlyMap<string, TarFile>) {
  const problems: string[] = []
  if (!NAME.test(name) || name.length > MAX_NAME) {
    problems.push('the directory name is not a valid skill name')
  }
  const skillMd = files.get('SKILL.md')
  if (skillMd === undefined) {
    return { problems: [...problems, 'SKILL.md is missing'], description: '' }
  }
  const fields = parseFrontmatter(new TextDecoder().decode(skillMd.content))
  if (fields === undefined) {
    problems.push('SKILL.md needs YAML frontmatter')
  } else if (fields.name !== name) {
    problems.push(`SKILL.md must have name: ${name}`)
  }
  const description =
    typeof fields?.description === 'string' ? fields.description.trim() : ''
  if (description.length === 0 || description.length > MAX_DESCRIPTION) {
    problems.push(
      `SKILL.md needs a description of 1 to ${MAX_DESCRIPTION} characters`
    )
  }
  if (files.size > MAX_FILES) {
    problems.push(`more than ${MAX_FILES} files`)
  }
  let bytes = 0
  for (const file of files.values()) {
    bytes += file.content.length
  }
  if (bytes > MAX_BYTES) {
    problems.push(`more than ${MAX_BYTES} bytes`)
  }
  return { problems, description }
}

/**
 * Build the published file of a valid skill.
 *
 * @param name - Skill name.
 * @param description - Skill description.
 * @param files - Skill files by relative path, including `SKILL.md`.
 */
function buildSkill(
  name: string,
  description: string,
  files: ReadonlyMap<string, TarFile>
): PublishedSkill {
  const archive = files.size > 1
  const bytes = archive
    ? tarGz(files)
    : (files.get('SKILL.md')?.content ?? new Uint8Array())
  return {
    name,
    description,
    type: archive ? 'archive' : 'skill-md',
    file: archive ? `${name}.tar.gz` : `${name}/SKILL.md`,
    contentType: archive ? 'application/gzip' : 'text/markdown; charset=utf-8',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: new Uint8Array(bytes),
  }
}
