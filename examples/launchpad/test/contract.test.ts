/**
 * Runs the built binary through many valid and invalid invocations and
 * checks the agent output contract on each: one JSON line on stdout, exit
 * code 0 exactly when the result has `data`, no ANSI codes, no JSON on stderr, and
 * the secret token never printed.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertContract, exec } from 'clipact/testing'

const BIN = fileURLToPath(new URL('../bin/launchpad.js', import.meta.url))
const TOKEN = 'lp_super_secret_value'
let env: Record<string, string>
let site: string

before(async () => {
  env = {
    LAUNCHPAD_TOKEN: TOKEN,
    LAUNCHPAD_HOME: await mkdtemp(join(tmpdir(), 'launchpad-contract-')),
    LAUNCHPAD_MOCK_LATENCY_MS: '0',
  }
  site = await mkdtemp(join(tmpdir(), 'launchpad-contract-site-'))
  await writeFile(join(site, 'index.html'), 'hi')
})

/** [args, expected error code or `ok`, stdin, extra environment] */
type Case = [string[], string, string?, Record<string, string>?]

const cases = (): Case[] => [
  [['sites', 'create', 'contract'], 'ok'],
  [['sites', 'create', 'contract'], 'conflict'],
  [['sites', 'list', '--debug'], 'ok'],
  [['sites', 'list', '--limit', '0'], 'invalid_input'],
  [['sites', 'list', '--limit', '0x10'], 'invalid_input'],
  [['sites', 'list', '--limit'], 'invalid_input'],
  [['sites', 'list', '--cursor', 'a', '--cursor', 'b'], 'invalid_input'],
  [['sites', 'get'], 'invalid_input'],
  [['sites', 'get', 'a', 'b'], 'invalid_input'],
  [['sites', 'get', 'nope'], 'not_found'],
  [['sitez'], 'invalid_input'],
  [['sites'], 'invalid_input'],
  [[], 'invalid_input'],
  [['sites', 'create', 'bell\u0007'], 'invalid_input'],
  [['sites', 'create', 'meta-bad', '--meta', '{oops'], 'invalid_input'],
  [['sites', 'create', '--input', '/does/not/exist.json'], 'invalid_input'],
  [['sites', 'create', '--input', '-'], 'invalid_input', '[1]'],
  [
    ['sites', 'create', '--input', '-'],
    'invalid_input',
    `{"name":"x-1","token":"${TOKEN}"}`,
  ],
  [
    ['sites', 'create', '--input', '-'],
    'ok',
    '{"name":"from-stdin","meta":{"a":"b"}}',
  ],
  [['whoami', '--token', TOKEN], 'invalid_input'],
  [['whoami', '--debug'], 'ok'],
  [['whoami'], 'auth_required', undefined, { LAUNCHPAD_TOKEN: 'nope' }],
  [['whoami', '--format', 'xml'], 'invalid_input'],
  [['whoami'], 'invalid_input', undefined, { LAUNCHPAD_OUTPUT: 'yaml' }],
  [['whoami'], 'ok', undefined, { CLAUDECODE: '1' }],
  [['ls'], 'rate_limited', undefined, { LAUNCHPAD_MOCK_RATE_LIMIT: '1' }],
  [['deploy', 'contract', site, '--prod'], 'confirmation_required'],
  [['deploy', 'contract', site, '--prod', '--dry-run'], 'ok'],
  [['deploy', 'contract', site, '--', 'missing-file'], 'file_not_found'],
  [['deploy', 'contract', site], 'ok'],
  [['deploys', 'status', 'dpl_404'], 'not_found'],
  [['sites', 'domains', 'add', 'contract', 'shop.com'], 'verification_pending'],
  [['sites', 'delete', 'contract'], 'confirmation_required'],
  [['sites', 'delete', 'contract', '--yes'], 'ok'],
  [['schema', 'sites', 'lst'], 'invalid_input'],
  [['schema', 'deploys', 'create'], 'ok'],
]

test('every invocation honors the output contract', async () => {
  for (const [args, expected, stdin, extra] of cases()) {
    const label = `launchpad ${args.join(' ')}`
    const result = await exec(BIN, args, { env: { ...env, ...extra }, stdin })
    const json = assertContract(result)
    const actual = 'data' in json ? 'ok' : (json.error as { code: string }).code
    assert.equal(actual, expected, `${label}: ${result.stdout}`)
    assert.ok(
      !(result.stdout + result.stderr).includes(TOKEN),
      `${label} printed the token`
    )
    if ('error' in json) {
      assert.match(
        result.stderr,
        /^launchpad: /,
        `${label} has no stderr summary`
      )
    }
  }
})

test('discovery loads only the entry chunks, never handlers or the SDK', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-trace-'))
  const hook = join(dir, 'hook.mjs')
  await writeFile(
    hook,
    `import module from 'node:module'
import { appendFileSync } from 'node:fs'
module.registerHooks({
  load(url, context, next) {
    if (url.includes('/dist/')) appendFileSync(process.env.TRACE, url.split('/dist/')[1] + '\\n')
    return next(url, context)
  },
})`
  )
  /** Returns the bundle files a command loads. */
  const loaded = async (args: string[], name: string) => {
    const trace = join(dir, `${name}.txt`)
    await exec(BIN, args, {
      env: { ...env, NODE_OPTIONS: `--import=${hook}`, TRACE: trace },
    })
    return new Set((await readFile(trace, 'utf8')).trim().split('\n'))
  }
  const entry = await loaded(['--version'], 'version')
  for (const [name, args] of [
    ['help', ['--help']],
    ['schema', ['schema', 'deploys', 'create']],
    ['command-help', ['deploys', 'create', '--help']],
  ] as const) {
    assert.deepEqual(await loaded([...args], name), entry, name)
  }
  const command = await loaded(['sites', 'list'], 'list')
  assert.ok(
    command.size > entry.size,
    'running a command loads its handler chunks'
  )
  assert.ok([...command].some((file) => file.startsWith('chunks/list-')))
})
