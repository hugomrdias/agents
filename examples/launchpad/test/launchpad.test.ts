import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertContract,
  assertDefinitions,
  exec,
  invoke,
  schemas,
} from 'clipact/testing'
import { cli } from '../src/cli.ts'

const BIN = fileURLToPath(new URL('../bin/launchpad.js', import.meta.url))
const env = { LAUNCHPAD_TOKEN: 'lp_test' }
let site: string

/** Runs the CLI in process and returns the asserted result. */
async function run(args: string[], options: Parameters<typeof invoke>[2] = {}) {
  const result = await invoke(cli, args, { env, ...options })
  return { ...result, json: assertContract(result) }
}

/** Returns the error code of a result. */
function code(json: Record<string, unknown>): string | undefined {
  return (json.error as { code: string } | undefined)?.code
}

before(async () => {
  // The mock SDK reads its knobs from the real environment.
  process.env.LAUNCHPAD_HOME = await mkdtemp(join(tmpdir(), 'launchpad-test-'))
  process.env.LAUNCHPAD_MOCK_LATENCY_MS = '0'
  site = await mkdtemp(join(tmpdir(), 'launchpad-site-'))
  await mkdir(join(site, 'assets'))
  await writeFile(join(site, 'index.html'), '<h1>hi</h1>')
  await writeFile(join(site, 'assets', 'app.js'), 'console.log(1)')
})

test('definitions are valid and every command has a schema', () => {
  assertDefinitions(cli)
  assert.deepEqual(Object.keys(schemas(cli)), [
    'sites list',
    'sites get',
    'sites create',
    'sites delete',
    'sites domains add',
    'deploys create',
    'deploys status',
    'deploys resume',
    'whoami',
    'skills install',
    'skills status',
    'skills uninstall',
  ])
})

describe('sites', () => {
  test('create, get, and list with pagination', async () => {
    const created = await run(
      ['sites', 'create', 'alpha', '--framework', 'astro'],
      {
        env: { ...env, LAUNCHPAD_REGION: 'eu' },
      }
    )
    const alpha = created.json.site as {
      id: string
      region: string
      framework: string
    }
    assert.equal(alpha.region, 'eu') // environment fallback
    assert.equal(alpha.framework, 'astro')

    // A complex request from --input on stdin, including an object field.
    await run(['sites', 'create', '--input', '-'], {
      stdin: '{"name":"beta","meta":{"owner":"web"}}',
    })
    await run(['sites', 'create', 'gamma'])

    const got = await run(['sites', 'get', 'beta'])
    assert.deepEqual((got.json.site as { meta: unknown }).meta, {
      owner: 'web',
    })

    const page = await run(['ls', '--limit', '2'])
    assert.deepEqual(
      (page.json.sites as { name: string }[]).map((s) => s.name),
      ['alpha', 'beta']
    )
    assert.equal(page.json.nextCursor, '2')
    assert.deepEqual(page.json.next, [
      {
        by: 'agent',
        command: 'launchpad sites list --limit 2 --cursor 2',
        description: 'Fetch the next page',
      },
    ])
  })

  test('maps SDK errors to stable codes', async () => {
    assert.equal(
      code((await run(['sites', 'create', 'alpha'])).json),
      'conflict'
    )
    const missing = await run(['sites', 'get', 'nope'])
    assert.equal(code(missing.json), 'not_found')
    const auth = await run(['whoami'], { env: { LAUNCHPAD_TOKEN: 'wrong' } })
    assert.equal(code(auth.json), 'auth_required')
    assert.equal((auth.json.next as { by: string }[])[0]?.by, 'user')
  })

  test('rate limits are retryable only for read-only commands', async () => {
    process.env.LAUNCHPAD_MOCK_RATE_LIMIT = '1'
    try {
      const result = await run(['sites', 'list'])
      assert.deepEqual(result.json.error, {
        code: 'rate_limited',
        message: 'Too many requests.',
        retryable: true,
        retryAfterSeconds: 5,
      })
    } finally {
      delete process.env.LAUNCHPAD_MOCK_RATE_LIMIT
    }
  })

  test('validates input and keeps secrets out of flags', async () => {
    const result = await run(['sites', 'create', 'Bad Name', '--token', 'lp_x'])
    assert.deepEqual((result.json.error as { details: unknown }).details, [
      {
        path: 'token',
        source: 'flag',
        message: 'Secret values are read only from LAUNCHPAD_TOKEN',
      },
      {
        path: 'name',
        source: 'positional',
        message: 'Use 3–40 lowercase letters, digits, or hyphens',
      },
    ])
  })

  test('domains return a partial result that needs the user', async () => {
    const result = await run([
      'sites',
      'domains',
      'add',
      'alpha',
      'a.example',
      'shop.com',
    ])
    assert.equal(code(result.json), 'verification_pending')
    assert.deepEqual(
      (result.json.domains as { name: string; verified: boolean }[]).map(
        (d) => [d.name, d.verified]
      ),
      [
        ['a.example', true],
        ['shop.com', false],
      ]
    )
    assert.deepEqual(
      (result.json.next as { by: string }[]).map((step) => step.by),
      ['user', 'agent']
    )
    const verified = await run([
      'sites',
      'domains',
      'add',
      'alpha',
      'a.example',
    ])
    assert.equal(verified.json.ok, true)
  })

  test('delete requires confirmation, previews with --dry-run, and runs with --yes', async () => {
    const gated = await run(['sites', 'delete', 'gamma'], {
      env: { ...env, AI_AGENT: 'codex' },
    })
    assert.equal(code(gated.json), 'confirmation_required')
    assert.equal(
      (gated.json.next as { command: string }[])[0]?.command,
      'launchpad sites delete gamma --yes'
    )
    const preview = await run(['sites', 'delete', 'gamma', '--dry-run'])
    assert.equal(preview.json.deleted, false)
    const deleted = await run(['sites', 'delete', 'gamma', '--yes'])
    assert.equal(deleted.json.deleted, true)
    assert.equal(code((await run(['sites', 'get', 'gamma'])).json), 'not_found')
  })
})

describe('deploys', () => {
  test('dry run reports the plan without creating a deployment', async () => {
    const result = await run(['deploy', 'alpha', site, '--dry-run'])
    const deployment = result.json.deployment as { files: number; id: string }
    assert.equal(result.json.dryRun, true)
    assert.equal(deployment.files, 2)
  })

  test('uploads folders and reports missing paths at once', async () => {
    const result = await run(['deploys', 'create', 'alpha', site])
    const deployment = result.json.deployment as {
      status: string
      uploaded: number
      id: string
    }
    assert.equal(deployment.status, 'ready')
    assert.equal(deployment.uploaded, 2)
    assert.match(
      result.stderr,
      /started dpl_\d+; if interrupted, run: launchpad deploys resume dpl_\d+/
    )

    const missing = await run(['deploys', 'create', 'alpha', 'nope1', 'nope2'])
    assert.equal(code(missing.json), 'file_not_found')
    assert.equal(
      (missing.json.error as { details: unknown[] }).details.length,
      2
    )
  })

  test('production deploys need confirmation', async () => {
    const result = await run(['deploys', 'create', 'alpha', site, '--prod'])
    assert.equal(code(result.json), 'confirmation_required')
    const confirmed = await run([
      'deploys',
      'create',
      'alpha',
      site,
      '--prod',
      '--yes',
    ])
    assert.equal(
      (confirmed.json.deployment as { url: string }).url,
      'https://alpha.launchpad.example'
    )
  })

  test('human output', async () => {
    const result = await invoke(cli, ['deploys', 'create', 'alpha', site], {
      env: { ...env, LAUNCHPAD_OUTPUT: 'human' },
    })
    assert.match(
      result.stdout,
      /^Deployed 2 files to https:\/\/dpl_\d+--alpha\.launchpad\.example\n$/
    )
    assert.match(result.stderr, /Next:\n {2}Inspect the deployment/)
  })
})

describe('built binary', () => {
  const binEnv = () => ({
    ...env,
    LAUNCHPAD_HOME: process.env.LAUNCHPAD_HOME,
    LAUNCHPAD_MOCK_LATENCY_MS: '200',
  })

  test('prints the version and reports the caller', async () => {
    const version = await exec(BIN, ['--version'])
    assert.equal(version.stdout, '0.1.0\n')
    const whoami = await exec(BIN, ['whoami'], {
      env: { ...binEnv(), CLAUDECODE: '1' },
    })
    assert.deepEqual(assertContract(whoami), {
      ok: true,
      team: 'personal',
      agent: 'claude-code',
      format: 'json',
      interactive: false,
    })
  })

  test('an interrupted deploy re-raises SIGTERM and can be resumed', async () => {
    const interrupted = await exec(BIN, ['deploys', 'create', 'alpha', site], {
      env: binEnv(),
      kill: { signal: 'SIGTERM', when: 'upload: 1/2' },
    })
    assert.equal(interrupted.signal, 'SIGTERM')
    const json = assertContract(interrupted)
    assert.equal(code(json), 'interrupted')
    const resume = (json.next as { command: string }[])[0]?.command as string
    assert.match(resume, /^launchpad deploys resume dpl_\d+$/)

    const id = resume.split(' ').at(-1) as string
    const status = await exec(BIN, ['deploys', 'status', id], { env: binEnv() })
    assert.equal(
      (assertContract(status).deployment as { status: string }).status,
      'uploading'
    )

    const resumed = await exec(BIN, ['deploys', 'resume', id], {
      env: binEnv(),
    })
    const deployment = assertContract(resumed).deployment as {
      status: string
      uploaded: number
    }
    assert.equal(deployment.status, 'ready')
    assert.equal(deployment.uploaded, 2)
  })
})
