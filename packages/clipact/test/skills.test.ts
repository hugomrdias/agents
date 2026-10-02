import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
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

/** SHA-256 of a string, as manifests record it. */
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

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
    manifest.files['old/removed.md'] = sha('old')
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
      message: `Not replacing skill directories with local changes, symbolic links, or files not installed by acme: ${join(project, '.agents/skills/acme')}, ${join(project, '.claude/skills/acme')}.`,
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
    assert.deepEqual(result.next, [
      {
        by: 'agent',
        command: 'acme skills install --scope global',
        description: 'Install the skills for every project',
      },
    ])
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

  test('stays quiet for a copy that install would refuse to write', async () => {
    const outside = join(project, '..', 'outside')
    await mkdir(join(outside, 'skills/acme'), { recursive: true })
    await writeFile(
      join(outside, 'skills/acme/.clipact.json'),
      JSON.stringify({ cli: 'acme', version: '1.0.0', files: {} })
    )
    await symlink(outside, join(project, '.claude'))

    const human = await invoke(cli, [
      'artifacts',
      'label',
      'id1',
      'a',
      '--format',
      'human',
    ])
    assert.doesNotMatch(human.stderr, /skill/)
  })
})

describe('skills safety', () => {
  test('ignores manifests that list paths outside the copy', async () => {
    const outside = join(project, 'secret.txt')
    await writeFile(outside, 'keep me')
    const dir = join(project, '.claude/skills/acme')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, '.clipact.json'),
      JSON.stringify({
        cli: 'acme',
        version: '1.2.3',
        files: { '../../../secret.txt': sha('keep me') },
      })
    )

    const status = await skills('status', '--scope', 'project')
    assert.equal(
      (status.skills as { status: string }[])[1]?.status,
      'unmanaged'
    )
    const removed = await skills('uninstall')
    assert.equal(
      (removed.skills as { action: string }[])[1]?.action,
      'unmanaged'
    )
    await skills('install', '--force')
    assert.equal(await readFile(outside, 'utf8'), 'keep me')
  })

  test('never writes through symbolic links, even with --force', async () => {
    const outside = join(project, '..', 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'errors.md'), 'keep me')
    const dir = join(project, '.agents/skills/acme')
    await mkdir(dir, { recursive: true })
    await symlink(outside, join(dir, 'references'))
    await symlink(outside, join(project, '.claude'))

    const result = await invoke(cli, ['skills', 'install', '--force'])
    const json = assertContract(result)
    assert.deepEqual((json.error as { details: unknown }).details, [
      {
        name: 'acme',
        target: 'agents',
        path: dir,
        reason: 'symlink',
        files: [join(dir, 'references')],
      },
      {
        name: 'acme',
        target: 'claude',
        path: join(project, '.claude/skills/acme'),
        reason: 'symlink',
        files: [join(project, '.claude/skills/acme')],
        resolvesTo: join(outside, 'skills/acme'),
      },
    ])
    assert.match(
      (json.error as { message: string }).message,
      /\.claude\/skills\/acme resolves to .*outside\/skills\/acme, outside the current directory\.$/
    )
    assert.deepEqual(
      (json.next as { command?: string }[]).map((step) => step.command),
      [undefined, undefined, 'acme skills install --scope global']
    )
    assert.equal(await readFile(join(outside, 'errors.md'), 'utf8'), 'keep me')
    assert.deepEqual(await files(outside), ['errors.md'])
    const status = await skills('status', '--scope', 'project')
    assert.deepEqual(
      (status.skills as { status: string }[]).map((copy) => copy.status),
      ['symlink', 'symlink']
    )
  })

  test('refuses a linked ~/.claude and suggests alternatives', async () => {
    const dotfiles = join(home, '..', 'dotfiles')
    await mkdir(join(dotfiles, '.claude'), { recursive: true })
    await symlink(join(dotfiles, '.claude'), join(home, '.claude'))

    const result = await invoke(cli, [
      'skills',
      'install',
      '--scope',
      'global',
      '--target',
      'claude',
      '--force',
    ])
    const json = assertContract(result)
    assert.deepEqual((json.error as { details: unknown }).details, [
      {
        name: 'acme',
        target: 'claude',
        path: join(home, '.claude/skills/acme'),
        reason: 'symlink',
        files: [join(home, '.claude/skills/acme')],
        resolvesTo: join(dotfiles, '.claude/skills/acme'),
      },
    ])
    assert.deepEqual(json.next, [
      {
        by: 'user',
        description: `Copy the skills by hand from ${fileURLToPath(options.skills)}, or replace the linked directory with a real one; install never writes outside the home directory`,
      },
      {
        by: 'user',
        command: 'acme skills install --target claude',
        description: 'Install into the project scope instead',
      },
    ])
    assert.deepEqual(await files(dotfiles), [])
  })

  test('uninstall reports linked copies and skips missing ones', async () => {
    const outside = join(project, '..', 'outside')
    await mkdir(join(outside, 'skills/acme'), { recursive: true })
    await writeFile(join(outside, 'skills/acme/SKILL.md'), 'mine')
    await symlink(outside, join(project, '.claude'))
    await mkdir(join(project, '..', 'empty'))
    await symlink(join(project, '..', 'empty'), join(project, '.agents'))

    const removed = await skills('uninstall')
    assert.deepEqual(
      (removed.skills as { action: string }[]).map((copy) => copy.action),
      ['missing', 'symlink']
    )
    assert.equal(
      await readFile(join(outside, 'skills/acme/SKILL.md'), 'utf8'),
      'mine'
    )
  })

  test('updates copies of read-only shipped files', async () => {
    const source = join(project, '..', 'source')
    await mkdir(join(source, 'tool'), { recursive: true })
    await writeFile(join(source, 'tool/SKILL.md'), 'v1')
    await chmod(join(source, 'tool/SKILL.md'), 0o444)
    const readOnly = defineCli({ ...options, skills: source })
    assertContract(
      await invoke(readOnly, ['skills', 'install', '--target', 'claude'])
    )

    await chmod(join(source, 'tool/SKILL.md'), 0o644)
    await writeFile(join(source, 'tool/SKILL.md'), 'v2')
    await chmod(join(source, 'tool/SKILL.md'), 0o444)
    const updated = assertContract(
      await invoke(readOnly, ['skills', 'install', '--target', 'claude'])
    )
    assert.equal((updated.skills as { action: string }[])[0]?.action, 'updated')
    const path = join(project, '.claude/skills/tool/SKILL.md')
    assert.equal(await readFile(path, 'utf8'), 'v2')
    assert.equal((await stat(path)).mode & 0o777, 0o444)
  })

  test('refuses to overwrite a local file the new version starts shipping', async () => {
    await skills('install', '--target', 'agents')
    const dir = join(project, '.agents/skills/acme')
    const manifestPath = join(dir, '.clipact.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    // Simulate an older version that did not ship references/errors.md,
    // which the user then created themselves.
    delete manifest.files['references/errors.md']
    manifest.version = '1.0.0'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(dir, 'references/errors.md'), 'my notes')

    const result = await invoke(cli, [
      'skills',
      'install',
      '--target',
      'agents',
    ])
    const json = assertContract(result)
    assert.deepEqual((json.error as { details: unknown }).details, [
      {
        name: 'acme',
        target: 'agents',
        path: dir,
        reason: 'edited',
        files: ['references/errors.md'],
      },
    ])
    assert.equal(
      await readFile(join(dir, 'references/errors.md'), 'utf8'),
      'my notes'
    )

    // The same content is not a conflict: the file is adopted.
    await writeFile(
      join(dir, 'references/errors.md'),
      await readFile(
        new URL('./fixtures/skills/acme/references/errors.md', import.meta.url)
      )
    )
    const updated = await skills('install', '--target', 'agents')
    assert.equal((updated.skills as { action: string }[])[0]?.action, 'updated')
  })

  test('keeps the permission bits of shipped files', async () => {
    const source = join(project, '..', 'source')
    await mkdir(join(source, 'tool/scripts'), { recursive: true })
    await writeFile(join(source, 'tool/SKILL.md'), '---\nname: tool\n---\n')
    await writeFile(join(source, 'tool/scripts/run.sh'), '#!/bin/sh\necho ok\n')
    await chmod(join(source, 'tool/scripts/run.sh'), 0o755)
    const withScripts = defineCli({ ...options, skills: source })

    assertContract(
      await invoke(withScripts, ['skills', 'install', '--target', 'claude'])
    )
    const installed = await stat(
      join(project, '.claude/skills/tool/scripts/run.sh')
    )
    assert.equal(installed.mode & 0o777, 0o755)
  })
})
