import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { defineCli } from '../src/index.ts'
import {
  assertContract,
  assertDefinitions,
  invoke,
  schemas,
} from '../src/testing.ts'
import { cli as base } from './fixtures/cli.ts'

const options = {
  ...base.options,
  skills: new URL('./fixtures/skills/', import.meta.url),
}
const cli = defineCli(options)

let project = ''
let home = ''

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clipact-skills-')))
  project = join(root, 'project')
  home = join(root, 'home')
  await mkdir(project)
  await mkdir(home)
  process.chdir(project)
  process.env.HOME = home
})

/** Runs a `skills` command and returns its checked JSON result. */
async function skills(...args: string[]) {
  return assertContract(await invoke(cli, ['skills', ...args]))
}

/** Lists files below a directory, or `[]` when it does not exist. */
async function files(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
      .sort()
  } catch {
    return []
  }
}

describe('skills install', () => {
  test('copies each bundled skill to both project directories with a manifest', async () => {
    const result = await skills('install')
    assert.deepEqual(result, {
      ok: true,
      scope: 'project',
      skills: [
        {
          name: 'acme',
          target: 'agents',
          path: join(project, '.agents/skills/acme'),
          action: 'installed',
        },
        {
          name: 'acme',
          target: 'claude',
          path: join(project, '.claude/skills/acme'),
          action: 'installed',
        },
      ],
    })
    for (const dir of ['.agents', '.claude']) {
      assert.deepEqual(await files(join(project, dir, 'skills/acme')), [
        '.clipact.json',
        'SKILL.md',
        'references/errors.md',
      ])
    }
    const manifest = JSON.parse(
      await readFile(join(project, '.claude/skills/acme/.clipact.json'), 'utf8')
    )
    assert.equal(manifest.cli, 'acme')
    assert.equal(manifest.version, '1.2.3')
    assert.deepEqual(Object.keys(manifest.files), [
      'SKILL.md',
      'references/errors.md',
    ])
  })

  test('is idempotent', async () => {
    await skills('install')
    const again = await skills('install')
    assert.deepEqual(
      (again.skills as { action: string }[]).map((copy) => copy.action),
      ['unchanged', 'unchanged']
    )
  })

  test('writes nothing with --dry-run', async () => {
    const result = await skills('install', '--dry-run')
    assert.equal(
      (result.skills as { action: string }[])[0]?.action,
      'installed'
    )
    assert.deepEqual(await files(project), [])
  })

  test('installs to selected directories in the home directory', async () => {
    await skills('install', '--scope', 'global', '--target', 'claude')
    assert.deepEqual(await files(project), [])
    assert.deepEqual(await files(home), [
      '.claude/skills/acme/.clipact.json',
      '.claude/skills/acme/SKILL.md',
      '.claude/skills/acme/references/errors.md',
    ])
  })

  test('updates a copy from another version and removes files it no longer ships', async () => {
    await skills('install')
    const dir = join(project, '.agents/skills/acme')
    const manifestPath = join(dir, '.clipact.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await mkdir(join(dir, 'old'))
    await writeFile(join(dir, 'old/removed.md'), 'old')
    manifest.version = '1.0.0'
    manifest.files['old/removed.md'] = (await import('node:crypto'))
      .createHash('sha256')
      .update('old')
      .digest('hex')
    await writeFile(manifestPath, JSON.stringify(manifest))

    const result = await skills('install')
    assert.deepEqual(
      (result.skills as { action: string }[]).map((copy) => copy.action),
      ['updated', 'unchanged']
    )
    assert.deepEqual(await files(dir), [
      '.clipact.json',
      'SKILL.md',
      'references/errors.md',
    ])
  })

  test('refuses to replace edited or unmanaged copies without --force', async () => {
    await skills('install', '--target', 'agents')
    await writeFile(join(project, '.agents/skills/acme/SKILL.md'), 'mine')
    await mkdir(join(project, '.claude/skills/acme'), { recursive: true })
    await writeFile(join(project, '.claude/skills/acme/SKILL.md'), 'theirs')

    const result = await invoke(cli, ['skills', 'install'])
    const json = assertContract(result)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(json.error, {
      code: 'skill_conflict',
      message: `Not replacing skill directories that were edited or not installed by acme: ${join(project, '.agents/skills/acme')}, ${join(project, '.claude/skills/acme')}.`,
      retryable: false,
      details: [
        {
          name: 'acme',
          target: 'agents',
          path: join(project, '.agents/skills/acme'),
          reason: 'edited',
          files: ['SKILL.md'],
        },
        {
          name: 'acme',
          target: 'claude',
          path: join(project, '.claude/skills/acme'),
          reason: 'unmanaged',
        },
      ],
    })
    assert.deepEqual(json.next, [
      {
        by: 'user',
        command: 'acme skills install --force',
        description: 'Replace them, discarding local changes',
      },
    ])

    const forced = await skills('install', '--force')
    assert.deepEqual(
      (forced.skills as { action: string }[]).map((copy) => copy.action),
      ['updated', 'updated']
    )
    assert.match(
      await readFile(join(project, '.claude/skills/acme/SKILL.md'), 'utf8'),
      /^---\nname: acme/
    )
  })

  test('rejects an unknown scope by name', async () => {
    const result = await invoke(cli, ['skills', 'install', '--scope', 'team'])
    const json = assertContract(result)
    assert.deepEqual((json.error as { details: unknown }).details, [
      {
        path: 'scope',
        source: 'flag',
        message: 'Expected one of: project, global',
      },
    ])
  })
})

describe('skills status', () => {
  test('reports missing copies in both scopes and suggests installing', async () => {
    const result = await skills('status')
    const copies = result.skills as { scope: string; status: string }[]
    assert.deepEqual(
      copies.map((copy) => `${copy.scope}:${copy.status}`),
      ['project:missing', 'project:missing', 'global:missing', 'global:missing']
    )
    assert.equal(result.version, '1.2.3')
    assert.deepEqual(result.next, [
      {
        by: 'agent',
        command: 'acme skills install',
        description: 'Install the skills for this project',
      },
    ])
  })

  test('reports current, stale, edited, and unmanaged copies', async () => {
    await skills('install')
    const manifestPath = join(project, '.agents/skills/acme/.clipact.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, version: '1.0.0' })
    )
    await writeFile(join(project, '.claude/skills/acme/SKILL.md'), 'mine')
    await mkdir(join(home, '.claude/skills/acme'), { recursive: true })
    await writeFile(join(home, '.claude/skills/acme/SKILL.md'), 'theirs')

    const result = await skills('status')
    assert.deepEqual(
      (
        result.skills as {
          scope: string
          target: string
          status: string
          version?: string
        }[]
      ).map((copy) => [copy.scope, copy.target, copy.status, copy.version]),
      [
        ['project', 'agents', 'stale', '1.0.0'],
        ['project', 'claude', 'edited', '1.2.3'],
        ['global', 'agents', 'missing', undefined],
        ['global', 'claude', 'unmanaged', undefined],
      ]
    )
    assert.deepEqual(result.next, [
      {
        by: 'agent',
        command: 'acme skills install',
        description: 'Update the project skills to this version',
      },
    ])
  })

  test('limits the report to one scope', async () => {
    const result = await skills('status', '--scope', 'global')
    assert.deepEqual(
      (result.skills as { scope: string }[]).map((copy) => copy.scope),
      ['global', 'global']
    )
  })
})

describe('skills uninstall', () => {
  test('removes installed files and keeps edited and added ones', async () => {
    await skills('install')
    const agents = join(project, '.agents/skills/acme')
    await writeFile(join(agents, 'SKILL.md'), 'mine')
    await writeFile(join(agents, 'notes.md'), 'added')

    const result = await skills('uninstall')
    assert.deepEqual(result.skills, [
      {
        name: 'acme',
        target: 'agents',
        path: agents,
        action: 'removed',
        kept: ['SKILL.md', 'notes.md'],
      },
      {
        name: 'acme',
        target: 'claude',
        path: join(project, '.claude/skills/acme'),
        action: 'removed',
      },
    ])
    assert.deepEqual(await files(project), [
      '.agents/skills/acme/SKILL.md',
      '.agents/skills/acme/notes.md',
    ])
    const again = await skills('uninstall')
    assert.deepEqual(
      (again.skills as { action: string }[]).map((copy) => copy.action),
      ['unmanaged', 'missing']
    )
  })

  test('writes nothing with --dry-run', async () => {
    await skills('install')
    const before = await files(project)
    await skills('uninstall', '--dry-run')
    assert.deepEqual(await files(project), before)
  })
})

describe('skills discovery', () => {
  test('adds the commands to help, schema, and completion only when configured', async () => {
    assertDefinitions(cli)
    assert.deepEqual(
      Object.keys(schemas(cli)).filter((path) => path.startsWith('skills')),
      ['skills install', 'skills status', 'skills uninstall']
    )
    const help = await invoke(cli, ['--help', '--format', 'human'])
    assert.match(
      help.stdout,
      /skills install\s+Install the bundled agent skills/
    )
    const complete = await invoke(cli, ['__complete', 'skills', ''])
    assert.match(complete.stdout, /^install\t/m)

    const without = await invoke(base, ['skills', 'status'])
    assert.equal(
      (assertContract(without).error as { code: string }).code,
      'invalid_input'
    )
  })

  test('the install schema names its flags and side effects', () => {
    const schema = schemas(cli)['skills install'] as Record<string, unknown>
    assert.equal(schema.idempotent, true)
    assert.equal(schema.dryRun, true)
    assert.deepEqual(
      Object.keys((schema.input as { properties: object }).properties),
      ['scope', 'target', 'force']
    )
  })
})

describe('stale skill notice', () => {
  test('suggests reinstalling after a human-mode command, never on stdout', async () => {
    await skills('install', '--target', 'claude')
    const manifestPath = join(project, '.claude/skills/acme/.clipact.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, version: '1.0.0' })
    )

    const human = await invoke(cli, [
      'artifacts',
      'label',
      'id1',
      'a',
      '--format',
      'human',
    ])
    assert.equal(human.exitCode, 0)
    assert.doesNotMatch(human.stdout, /skill/)
    assert.match(
      human.stderr,
      /acme: the installed "acme" skill is from version 1\.0\.0; run "acme skills install" to update it\./
    )

    const machine = await invoke(cli, ['artifacts', 'label', 'id1', 'a'])
    assert.equal(machine.stderr, '')
  })
})
