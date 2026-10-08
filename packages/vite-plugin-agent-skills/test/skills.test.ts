import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DISCOVERY_SCHEMA,
  discoveryIndex,
  parseFrontmatter,
  publishSkills,
} from '../src/index.ts'
import { skillMd, skillsDir, temp } from './helpers.ts'

/**
 * The SHA-256 digest of bytes, as the index writes it.
 *
 * @param bytes - Bytes to hash.
 */
function digest(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

describe('publishSkills', () => {
  it('publishes a lone SKILL.md as skill-md', async () => {
    const dir = await skillsDir({ 'one/SKILL.md': skillMd('one') })
    const { skills, files } = await publishSkills(dir)
    const body = new TextEncoder().encode(skillMd('one'))
    assert.deepEqual(skills, [
      {
        name: 'one',
        description: 'Does one things.',
        type: 'skill-md',
        file: 'one/SKILL.md',
        contentType: 'text/markdown; charset=utf-8',
        digest: digest(body),
        bytes: body,
      },
    ])
    assert.deepEqual(files, [join(dir, 'one', 'SKILL.md')])
  })

  it('publishes a skill with more files as a tar.gz that tar extracts', async () => {
    const dir = await skillsDir({
      'two/SKILL.md': skillMd('two'),
      'two/references/guide.md': '# Guide\n',
      'two/scripts/run.sh': '#!/bin/sh\necho hi\n',
    })
    await chmod(join(dir, 'two/scripts/run.sh'), 0o755)
    const [skill] = (await publishSkills(dir)).skills
    assert.equal(skill?.type, 'archive')
    assert.equal(skill?.file, 'two.tar.gz')
    assert.equal(skill?.contentType, 'application/gzip')
    assert.equal(skill?.digest, digest(skill?.bytes ?? new Uint8Array()))

    const archive = join(temp, 'two.tar.gz')
    const out = join(temp, 'two-out')
    await writeFile(archive, skill?.bytes ?? new Uint8Array())
    await mkdir(out)
    execFileSync('tar', ['-xzf', archive, '-C', out])
    assert.equal(await readFile(join(out, 'SKILL.md'), 'utf8'), skillMd('two'))
    assert.equal(
      await readFile(join(out, 'references/guide.md'), 'utf8'),
      '# Guide\n'
    )
    const mode = (await stat(join(out, 'scripts/run.sh'))).mode
    assert.equal(mode & 0o111, 0o111)
    const listing = execFileSync('tar', ['-tvzf', archive], {
      encoding: 'utf8',
    })
    // Every entry has the zero timestamp.
    assert.equal(listing.trim().split('\n').length, 3)
    for (const line of listing.trim().split('\n')) {
      assert.match(line, /1970/)
    }
  })

  it('builds the same archive bytes every time', async () => {
    const dir = await skillsDir({
      'three/SKILL.md': skillMd('three'),
      'three/a.md': 'a',
    })
    const first = await publishSkills(dir)
    await writeFile(join(dir, 'three/a.md'), 'a')
    const second = await publishSkills(dir)
    assert.equal(first.skills[0]?.digest, second.skills[0]?.digest)
  })

  it('reads a multi-line YAML description', async () => {
    const dir = await skillsDir({
      'four/SKILL.md':
        '---\nname: four\ndescription: >-\n  Spans\n  lines.\n---\n# four\n',
    })
    const [skill] = (await publishSkills(dir)).skills
    assert.equal(skill?.description, 'Spans lines.')
  })

  it('lists every problem in one error', async () => {
    const dir = await skillsDir({
      'Bad_Name/SKILL.md': skillMd('Bad_Name'),
      'other/SKILL.md': skillMd('another'),
      'nodesc/SKILL.md': '---\nname: nodesc\n---\n',
      'empty/README.md': 'no skill',
    })
    await symlink(join(dir, 'other/SKILL.md'), join(dir, 'other/link.md'))
    await assert.rejects(publishSkills(dir), (error: Error) => {
      assert.match(error.message, /Bad_Name: the directory name/)
      assert.match(error.message, /other: SKILL.md must have name: other/)
      assert.match(error.message, /other: link.md is a symbolic link/)
      assert.match(error.message, /nodesc: SKILL.md needs a description/)
      assert.match(error.message, /empty: SKILL.md is missing/)
      return true
    })
  })
})

describe('discoveryIndex', () => {
  it('lists each skill with a URL relative to the index', async () => {
    const dir = await skillsDir({
      'one/SKILL.md': skillMd('one'),
      'two/SKILL.md': skillMd('two'),
      'two/a.md': 'a',
    })
    const { skills } = await publishSkills(dir)
    const index = discoveryIndex(skills)
    assert.equal(index.$schema, DISCOVERY_SCHEMA)
    assert.deepEqual(
      index.skills.map((skill) => [skill.name, skill.type, skill.url]),
      [
        ['one', 'skill-md', 'one/SKILL.md'],
        ['two', 'archive', 'two.tar.gz'],
      ]
    )
  })
})

describe('parseFrontmatter', () => {
  it('parses YAML fields', () => {
    assert.deepEqual(
      parseFrontmatter('---\nname: fil\ndescription: "Store: files."\n---\n'),
      { name: 'fil', description: 'Store: files.' }
    )
  })

  it('returns undefined without frontmatter or with invalid YAML', () => {
    assert.equal(parseFrontmatter('# fil'), undefined)
    assert.equal(parseFrontmatter('---\n: [\n---\n'), undefined)
    assert.equal(parseFrontmatter('---\n- a\n---\n'), undefined)
  })
})
