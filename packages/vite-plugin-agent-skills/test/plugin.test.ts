import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  build,
  createServer,
  createServerModuleRunner,
  type InlineConfig,
} from 'vite'
import { type AgentSkillsOptions, agentSkills } from '../src/index.ts'
import { skillMd, skillsDir, temp } from './helpers.ts'

let projects = 0

/**
 * Vite config for an empty app in a new directory, with the plugin.
 *
 * @param options - Plugin options.
 * @param config - Extra Vite config.
 */
async function project(
  options: AgentSkillsOptions,
  config: InlineConfig = {}
): Promise<InlineConfig> {
  const root = join(temp, `project-${projects++}`)
  await mkdir(root)
  await writeFile(join(root, 'index.html'), '<!doctype html><title>t</title>')
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [agentSkills(options)],
    ...config,
  }
}

describe('build', () => {
  it('writes the index and each skill file into the output', async () => {
    const dir = await skillsDir({
      'one/SKILL.md': skillMd('one'),
      'two/SKILL.md': skillMd('two'),
      'two/a.md': 'a',
    })
    const config = await project({ dir })
    await build(config)
    const out = join(config.root ?? '', 'dist', '.well-known', 'agent-skills')
    const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'))
    assert.deepEqual(
      index.skills.map((skill: { url: string }) => skill.url),
      ['one/SKILL.md', 'two.tar.gz']
    )
    assert.equal(
      await readFile(join(out, 'one', 'SKILL.md'), 'utf8'),
      skillMd('one')
    )
    assert.ok((await readFile(join(out, 'two.tar.gz'))).length > 0)
  })

  it('puts the files under the base option', async () => {
    const dir = await skillsDir({ 'one/SKILL.md': skillMd('one') })
    const config = await project({ dir, base: '/docs/' })
    await build(config)
    const index = join(
      config.root ?? '',
      'dist/docs/.well-known/agent-skills/index.json'
    )
    assert.ok(JSON.parse(await readFile(index, 'utf8')).skills.length === 1)
  })

  it('fails the build on an invalid skill', async () => {
    const dir = await skillsDir({ 'one/SKILL.md': skillMd('two') })
    await assert.rejects(
      build(await project({ dir })),
      /one: SKILL.md must have name: one/
    )
  })
})

describe('dev server', () => {
  it('serves the files, answers 404 for others, and reloads on change', async () => {
    const dir = await skillsDir({ 'one/SKILL.md': skillMd('one') })
    const server = await createServer(
      await project({ dir }, { base: '/app/', server: { port: 0 } })
    )
    await server.listen()
    try {
      // The local URL includes the `/app/` base.
      const local = server.resolvedUrls?.local[0]
      assert.ok(local)
      const url = (path: string) =>
        new URL(`.well-known/agent-skills/${path}`, local)

      const index = await fetch(url('index.json'))
      assert.equal(index.headers.get('access-control-allow-origin'), '*')
      assert.deepEqual(
        (await index.json()).skills.map((skill: { url: string }) => skill.url),
        ['one/SKILL.md']
      )
      const file = await fetch(url('one/SKILL.md'))
      assert.equal(
        file.headers.get('content-type'),
        'text/markdown; charset=utf-8'
      )
      assert.equal(await file.text(), skillMd('one'))
      const head = await fetch(url('one/SKILL.md'), { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')

      await mkdir(join(dir, 'two'))
      await writeFile(join(dir, 'two', 'SKILL.md'), skillMd('two'))
      await rm(join(dir, 'one'), { recursive: true })
      await waitFor(async () => {
        const body = await (await fetch(url('index.json'))).json()
        return body.skills.map((skill: { name: string }) => skill.name)
      }, ['two'])
      assert.equal((await fetch(url('one/SKILL.md'))).status, 404)
      assert.equal((await fetch(url('nope.tar.gz'))).status, 404)
    } finally {
      await server.close()
    }
  })

  it('exposes the index and site paths in the virtual module', async () => {
    const dir = await skillsDir({ 'one/SKILL.md': skillMd('one') })
    const server = await createServer(
      await project({ dir }, { server: { middlewareMode: true, ws: false } })
    )
    const runner = createServerModuleRunner(server.environments.ssr, {
      hmr: false,
    })
    try {
      const module = await runner.import('virtual:agent-skills')
      assert.equal(module.index.skills[0].url, 'one/SKILL.md')
      assert.equal(
        module.skills[0].path,
        '/.well-known/agent-skills/one/SKILL.md'
      )
    } finally {
      await runner.close()
      await server.close()
    }
  })
})

/**
 * Poll until `read` returns a value deep-equal to `expected`, for up to five
 * seconds, then fail with the last value.
 *
 * @param read - Reads the current value.
 * @param expected - Value to wait for.
 */
async function waitFor<T>(read: () => Promise<T>, expected: T) {
  let value: T | undefined
  for (let attempt = 0; attempt < 50; attempt++) {
    value = await read()
    try {
      assert.deepEqual(value, expected)
      return
    } catch {
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  assert.deepEqual(value, expected)
}
