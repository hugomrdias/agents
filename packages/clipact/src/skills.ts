import { homedir } from 'node:os'
import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CliOptions,
  type Command,
  defineCommand,
  defineGroup,
  type Group,
  type Handler,
} from './define.ts'
import { fromJsonSchema, type JsonSchemaNode } from './json-schema.ts'

/** Where skills are installed: the current directory or the home directory. */
export type Scope = 'project' | 'global'

/** A skills directory: `.agents/skills` or `.claude/skills`. */
export type Target = 'agents' | 'claude'

/** Every skills directory, in installation order. */
export const TARGETS: readonly Target[] = ['agents', 'claude']

/** Input of `skills install`. */
export interface InstallInput {
  scope: Scope
  target: Target[]
  force: boolean
}

/** One installed copy reported by `skills install`. */
export interface InstalledCopy {
  name: string
  target: Target
  path: string
  action: 'installed' | 'updated' | 'unchanged'
}

/** Input of `skills uninstall`. */
export type UninstallInput = Omit<InstallInput, 'force'>

/** One copy reported by `skills uninstall`. */
export interface RemovedCopy {
  name: string
  target: Target
  path: string
  action: 'removed' | 'missing' | 'unmanaged' | 'symlink'
  /** Files left in place because they were edited or added locally. */
  kept?: string[]
}

/** Input of `skills status`. */
export interface StatusInput {
  scope?: Scope
}

/** The state of one copy reported by `skills status`. */
export interface CopyStatus {
  name: string
  scope: Scope
  target: Target
  path: string
  status: 'missing' | 'unmanaged' | 'symlink' | 'current' | 'stale' | 'edited'
  /** CLI version that installed the copy. */
  version?: string
}

const SCOPES = ['project', 'global'] as const

const scopeName: JsonSchemaNode = { type: 'string', enum: SCOPES }
const scope: JsonSchemaNode = {
  ...scopeName,
  description:
    'project installs under the current directory; global under the home directory',
}

const target: JsonSchemaNode = {
  type: 'array',
  items: { type: 'string', enum: TARGETS },
  default: TARGETS,
  description:
    'Skills directories: agents (.agents/skills) and claude (.claude/skills)',
}

const string: JsonSchemaNode = { type: 'string' }
const targetName: JsonSchemaNode = { type: 'string', enum: TARGETS }

/** A closed object schema whose fields are required unless listed in `optional`. */
function object(
  properties: Record<string, JsonSchemaNode>,
  optional: string[] = []
): JsonSchemaNode {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  }
}

/** The output of `install` and `uninstall`: the scope and one entry per copy. */
function copiesOutput(
  actions: string[],
  extra: Record<string, JsonSchemaNode> = {}
): JsonSchemaNode {
  return object({
    scope: scopeName,
    skills: {
      type: 'array',
      items: object(
        {
          name: string,
          target: targetName,
          path: string,
          action: { type: 'string', enum: actions },
          ...extra,
        },
        Object.keys(extra)
      ),
    },
  })
}

const installInput = fromJsonSchema<Partial<InstallInput>, InstallInput>({
  type: 'object',
  properties: {
    scope: { ...scope, default: 'project' },
    target,
    force: {
      type: 'boolean',
      default: false,
      description:
        'Replace skill directories that were edited or not installed by this CLI',
    },
  },
  additionalProperties: false,
})

const installOutput = fromJsonSchema<{
  scope: Scope
  skills: InstalledCopy[]
}>(copiesOutput(['installed', 'updated', 'unchanged']))

const uninstallInput = fromJsonSchema<Partial<UninstallInput>, UninstallInput>({
  type: 'object',
  properties: { scope: { ...scope, default: 'project' }, target },
  additionalProperties: false,
})

const uninstallOutput = fromJsonSchema<{
  scope: Scope
  skills: RemovedCopy[]
}>(
  copiesOutput(['removed', 'missing', 'unmanaged', 'symlink'], {
    kept: { type: 'array', items: string },
  })
)

const statusInput = fromJsonSchema<StatusInput>({
  type: 'object',
  properties: {
    scope: { ...scope, description: `${scope.description}; both when omitted` },
  },
  additionalProperties: false,
})

const statusOutput = fromJsonSchema<{ version: string; skills: CopyStatus[] }>(
  object({
    version: { type: 'string', description: 'Version of the running CLI' },
    skills: {
      type: 'array',
      items: object(
        {
          name: string,
          scope: scopeName,
          target: targetName,
          path: string,
          status: {
            type: 'string',
            enum: [
              'missing',
              'unmanaged',
              'symlink',
              'current',
              'stale',
              'edited',
            ],
          },
          version: string,
        },
        ['version']
      ),
    },
  })
)

/** The `skills install` command. */
export type InstallCommand = Command<typeof installInput, typeof installOutput>

/** The `skills uninstall` command. */
export type UninstallCommand = Command<
  typeof uninstallInput,
  typeof uninstallOutput
>

/** The `skills status` command. */
export type StatusCommand = Command<typeof statusInput, typeof statusOutput>

/** Shortens a path for human output: relative to the current directory, or under `~`. */
function display(path: string): string {
  const cwd = process.cwd()
  if (path.startsWith(`${cwd}${sep}`)) {
    return relative(cwd, path)
  }
  const home = homedir()
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
}

/** Converts the `skills` option, a path or `file:` URL, to a path. */
export function skillsPath(source: URL | string): string {
  return typeof source === 'string' && !source.startsWith('file:')
    ? source
    : fileURLToPath(source)
}

/** Loads a handler from `skills.run.ts` only when its command runs. */
function lazy(create: (run: typeof import('./skills.run.ts')) => Handler) {
  return async () => ({ default: create(await import('./skills.run.ts')) })
}

/**
 * Builds the `skills` group that installs the skills bundled in `source`, a
 * directory of `<name>/SKILL.md` skill directories.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#a-setup-command
 */
export function skillsGroup(cli: CliOptions, skills: URL | string): Group {
  const source = skillsPath(skills)
  const install: InstallCommand = defineCommand({
    name: 'install',
    description: 'Install the bundled agent skills',
    examples: [
      `${cli.name} skills install`,
      `${cli.name} skills install --scope global --target claude`,
    ],
    input: installInput,
    output: installOutput,
    errors: ['skill_conflict'],
    idempotent: true,
    dryRun: true,
    human: (data) =>
      data.skills
        .map((copy) => `${copy.action}: ${display(copy.path)}`)
        .join('\n'),
    handler: lazy((run) => run.install(cli, source, install)),
  })
  const uninstall: UninstallCommand = defineCommand({
    name: 'uninstall',
    description: 'Remove installed skill files that were not edited',
    examples: [`${cli.name} skills uninstall`],
    input: uninstallInput,
    output: uninstallOutput,
    idempotent: true,
    dryRun: true,
    human: (data) =>
      data.skills
        .map(
          (copy) =>
            `${copy.action}: ${display(copy.path)}${copy.kept ? ` (kept ${copy.kept.join(', ')})` : ''}`
        )
        .join('\n'),
    handler: lazy((run) => run.uninstall(cli, source, uninstall)),
  })
  const status: StatusCommand = defineCommand({
    name: 'status',
    description: 'Report installed skills and whether they are stale or edited',
    examples: [`${cli.name} skills status --json`],
    input: statusInput,
    output: statusOutput,
    readOnly: true,
    human: (data) =>
      data.skills
        .map(
          (copy) =>
            `${copy.status.padEnd(9)} ${display(copy.path)}${copy.version ? ` (${copy.version})` : ''}`
        )
        .join('\n'),
    handler: lazy((run) => run.status(cli, source, status)),
  })
  return defineGroup({
    name: 'skills',
    description: 'Install the agent skills bundled with this CLI',
    commands: [install, status, uninstall],
  })
}
