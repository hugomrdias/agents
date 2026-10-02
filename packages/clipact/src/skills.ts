import { homedir } from 'node:os'
import { relative, sep } from 'node:path'
import {
  type CliOptions,
  type Command,
  defineCommand,
  defineGroup,
  type Group,
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
export interface UninstallInput {
  scope: Scope
  target: Target[]
}

/** One copy reported by `skills uninstall`. */
export interface RemovedCopy {
  name: string
  target: Target
  path: string
  action: 'removed' | 'missing' | 'unmanaged'
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
  status: 'missing' | 'unmanaged' | 'current' | 'stale' | 'edited'
  /** CLI version that installed the copy. */
  version?: string
}

const SCOPES = ['project', 'global'] as const

const scope: JsonSchemaNode = {
  type: 'string',
  enum: SCOPES,
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

const name: JsonSchemaNode = { type: 'string' }
const path: JsonSchemaNode = { type: 'string' }

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
}>({
  type: 'object',
  properties: {
    scope: { type: 'string', enum: SCOPES },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name,
          target: { type: 'string', enum: TARGETS },
          path,
          action: {
            type: 'string',
            enum: ['installed', 'updated', 'unchanged'],
          },
        },
        required: ['name', 'target', 'path', 'action'],
        additionalProperties: false,
      },
    },
  },
  required: ['scope', 'skills'],
  additionalProperties: false,
})

const uninstallInput = fromJsonSchema<Partial<UninstallInput>, UninstallInput>({
  type: 'object',
  properties: { scope: { ...scope, default: 'project' }, target },
  additionalProperties: false,
})

const uninstallOutput = fromJsonSchema<{
  scope: Scope
  skills: RemovedCopy[]
}>({
  type: 'object',
  properties: {
    scope: { type: 'string', enum: SCOPES },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name,
          target: { type: 'string', enum: TARGETS },
          path,
          action: { type: 'string', enum: ['removed', 'missing', 'unmanaged'] },
          kept: { type: 'array', items: path },
        },
        required: ['name', 'target', 'path', 'action'],
        additionalProperties: false,
      },
    },
  },
  required: ['scope', 'skills'],
  additionalProperties: false,
})

const statusInput = fromJsonSchema<StatusInput>({
  type: 'object',
  properties: {
    scope: { ...scope, description: `${scope.description}; both when omitted` },
  },
  additionalProperties: false,
})

const statusOutput = fromJsonSchema<{ version: string; skills: CopyStatus[] }>({
  type: 'object',
  properties: {
    version: { type: 'string', description: 'Version of the running CLI' },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name,
          scope: { type: 'string', enum: SCOPES },
          target: { type: 'string', enum: TARGETS },
          path,
          status: {
            type: 'string',
            enum: ['missing', 'unmanaged', 'current', 'stale', 'edited'],
          },
          version: { type: 'string' },
        },
        required: ['name', 'scope', 'target', 'path', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['version', 'skills'],
  additionalProperties: false,
})

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

/**
 * Builds the `skills` group that installs the skills bundled in `source`, a
 * directory of `<name>/SKILL.md` skill directories.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#a-setup-command
 */
export function skillsGroup(cli: CliOptions, source: URL | string): Group {
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
    handler: async () => ({
      default: (await import('./skills.run.ts')).install(cli, source, install),
    }),
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
    handler: async () => ({
      default: (await import('./skills.run.ts')).uninstall(
        cli,
        source,
        uninstall
      ),
    }),
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
    handler: async () => ({
      default: (await import('./skills.run.ts')).status(cli, source, status),
    }),
  })
  return defineGroup({
    name: 'skills',
    description: 'Install the agent skills bundled with this CLI',
    commands: [install, status, uninstall],
  })
}
