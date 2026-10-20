import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { beforeEach, describe, test } from 'node:test'
import * as z from 'zod'
import type { Env } from '../src/agent.ts'
import {
  type CliOptions,
  type Command,
  defineCli,
  defineCommand,
  defineHandler,
  type TelemetryEvent,
} from '../src/index.ts'
import { detectProvider } from '../src/provider.ts'
import { resolveSpec } from '../src/spec.ts'
import {
  flagNames,
  readState,
  resolveTelemetry,
  stateFile,
  writeState,
} from '../src/telemetry.run.ts'
import { assertContract, assertDefinitions, invoke } from '../src/testing.ts'
import { cli as base } from './fixtures/cli.ts'

const sender = new URL('./fixtures/telemetry-sender.ts', import.meta.url)

/** Returns `ctx.telemetry()` as data. */
const probe: Command<undefined, undefined> = defineCommand({
  name: 'probe',
  description: 'Report the telemetry status',
  readOnly: true,
  handler: async () => ({
    default: defineHandler(probe, async (ctx) =>
      ctx.ok({ ...(await ctx.telemetry()) })
    ),
  }),
})

/** Reads the status, then saves `telemetry disable` while still running. */
const racer: Command<undefined, undefined> = defineCommand({
  name: 'racer',
  description: 'Save a choice while the command runs',
  handler: async () => ({
    default: defineHandler(racer, async (ctx) => {
      await ctx.telemetry()
      await mkdir(dirname(file()), { recursive: true })
      await writeFile(file(), JSON.stringify({ telemetry: 'disabled' }))
      return ctx.ok()
    }),
  }),
})

/** The fixture CLI with telemetry and the probe command. */
function withTelemetry(telemetry: CliOptions['telemetry'] = { sender }) {
  return defineCli({
    ...base.options,
    commands: [...base.options.commands, probe, racer],
    telemetry,
  })
}

const cli = withTelemetry()

let home = ''
let env: Env = {}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clipact-telemetry-'))
  env = { HOME: home, XDG_STATE_HOME: join(home, 'state') }
})

/** The state file the CLI uses under the test home directory. */
function file(): string {
  return stateFile('acme', env) as string
}

describe('telemetry status resolution', () => {
  const options = cli.options
  const resolve = async (vars: Env, state?: object) => {
    const target = file()
    if (state) {
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, JSON.stringify(state))
    }
    return (await resolveTelemetry(options, 'ACME', { ...env, ...vars })).status
  }

  test('defaults to on', async () => {
    assert.deepEqual(await resolve({}), {
      enabled: true,
      optedOut: false,
      source: 'default',
    })
  })

  test('DO_NOT_TRACK wins over every opt-in', async () => {
    assert.deepEqual(
      await resolve(
        { DO_NOT_TRACK: 'true', ACME_TELEMETRY: '1' },
        { telemetry: 'enabled' }
      ),
      {
        enabled: false,
        optedOut: true,
        source: 'env',
        variable: 'DO_NOT_TRACK',
      }
    )
  })

  test('DO_NOT_TRACK set to empty, 0, or false is not an opt-out', async () => {
    for (const value of ['', '0', 'false']) {
      assert.equal((await resolve({ DO_NOT_TRACK: value })).enabled, true)
    }
  })

  test('<PREFIX>_TELEMETRY=0 opts out', async () => {
    assert.deepEqual(await resolve({ ACME_TELEMETRY: '0' }), {
      enabled: false,
      optedOut: true,
      source: 'env',
      variable: 'ACME_TELEMETRY',
    })
  })

  test('a saved disable wins over <PREFIX>_TELEMETRY=1', async () => {
    assert.deepEqual(
      await resolve({ ACME_TELEMETRY: '1' }, { telemetry: 'disabled' }),
      { enabled: false, optedOut: true, source: 'config' }
    )
  })

  test('<PREFIX>_TELEMETRY=1 and a saved enable override default off', async () => {
    const options = withTelemetry({ sender, default: 'off' }).options
    const off = await resolveTelemetry(options, 'ACME', env)
    assert.deepEqual(off.status, {
      enabled: false,
      optedOut: false,
      source: 'default',
    })
    const forced = await resolveTelemetry(options, 'ACME', {
      ...env,
      ACME_TELEMETRY: '1',
    })
    assert.equal(forced.status.enabled, true)
    assert.equal(forced.status.source, 'env')
    await mkdir(join(file(), '..'), { recursive: true })
    await writeFile(file(), JSON.stringify({ telemetry: 'enabled' }))
    const saved = await resolveTelemetry(options, 'ACME', env)
    assert.deepEqual(saved.status, {
      enabled: true,
      optedOut: false,
      source: 'config',
    })
  })

  test('<PREFIX>_TELEMETRY=log is on and logs', async () => {
    const resolved = await resolveTelemetry(options, 'ACME', {
      ...env,
      ACME_TELEMETRY: 'log',
    })
    assert.equal(resolved.status.enabled, true)
    assert.equal(resolved.log, true)
  })

  test('without a telemetry option, only the environment opt-outs count', async () => {
    assert.deepEqual(
      (await resolveTelemetry(base.options, 'ACME', env)).status,
      { enabled: false, optedOut: false, source: 'unconfigured' }
    )
    assert.deepEqual(
      (await resolveTelemetry(base.options, 'ACME', { DO_NOT_TRACK: '1' }))
        .status,
      {
        enabled: false,
        optedOut: true,
        source: 'unconfigured',
        variable: 'DO_NOT_TRACK',
      }
    )
  })

  test('a corrupt state file reads as empty', async () => {
    await mkdir(join(file(), '..'), { recursive: true })
    await writeFile(file(), '{not json')
    assert.deepEqual(await readState(file()), {})
  })
})

describe('telemetry helpers', () => {
  test('the state file follows the platform state directory', () => {
    assert.equal(
      stateFile('acme', { HOME: '/h' }, 'linux'),
      '/h/.local/state/acme/state.json'
    )
    assert.equal(
      stateFile('acme', { HOME: '/h', XDG_STATE_HOME: '/x' }, 'linux'),
      '/x/acme/state.json'
    )
    assert.equal(
      stateFile('acme', { HOME: '/h', XDG_STATE_HOME: 'relative' }, 'linux'),
      '/h/.local/state/acme/state.json'
    )
    assert.equal(
      stateFile('acme', { HOME: '/h' }, 'darwin'),
      '/h/Library/Application Support/acme/state.json'
    )
    assert.equal(stateFile('acme', {}, 'linux'), undefined)
    assert.equal(stateFile('acme', { HOME: '/h' }, 'win32'), undefined)
  })

  test('flag names keep known names only, without values', () => {
    const spec = undefined
    assert.deepEqual(
      flagNames(
        ['put', 'a.txt', '--network', 'mainnet', '--json', '-h', '--secret-x'],
        spec
      ),
      ['help', 'json']
    )
    assert.deepEqual(flagNames(['--no-agent', '--', '--json'], spec), [
      'no-agent',
    ])
  })

  test('flag names skip values that look like flags', () => {
    const note = defineCommand({
      name: 'note',
      description: 'Note',
      input: z.object({ message: z.string(), pin: z.boolean().optional() }),
      handler: async () => ({ default: undefined }),
    })
    const spec = resolveSpec(note, 'note')
    assert.deepEqual(flagNames(['note', '--message', '--json'], spec), [
      'message',
    ])
    assert.deepEqual(
      flagNames(['note', '--message=--debug', '--no-pin', '--json'], spec),
      ['json', 'message', 'no-pin']
    )
  })

  test('writeState removes its temporary file when the write fails', async () => {
    const target = join(home, 'taken', 'state.json')
    await mkdir(target, { recursive: true })
    await assert.rejects(writeState(target, { notice: true }))
    assert.deepEqual(await readdir(dirname(target)), ['state.json'])
  })

  test('defineCli rejects a relative sender path', () => {
    assert.throws(
      () => withTelemetry({ sender: './telemetry.js' }),
      /Telemetry sender "\.\/telemetry\.js" must be a URL or an absolute path/
    )
    withTelemetry({ sender: join(home, 'telemetry.js') })
    withTelemetry({ sender: sender.href })
  })
})

describe('detectProvider', () => {
  test('names the provider from its variable, in table order', () => {
    assert.equal(detectProvider({ GITHUB_ACTIONS: 'true' }), 'github_actions')
    assert.equal(detectProvider({ CI_MERGE_REQUEST_ID: '7' }), 'gitlab')
    assert.equal(detectProvider({ CIRCLECI: 'true' }), 'circle')
    assert.equal(
      detectProvider({ JENKINS_URL: 'x', HUDSON_URL: 'x' }),
      'jenkins'
    )
    assert.equal(detectProvider({ VERCEL_ENV: 'preview' }), 'vercel')
    assert.equal(detectProvider({ DENO_DEPLOYMENT_ID: 'd' }), 'deno-deploy')
  })

  test('returns undefined without a provider variable', () => {
    assert.equal(detectProvider({}), undefined)
    assert.equal(detectProvider({ GITHUB_ACTIONS: '' }), undefined)
    assert.equal(detectProvider({ CI: 'true' }), undefined)
  })
})

describe('telemetry events', () => {
  test('definitions are valid', () => assertDefinitions(cli))

  test('a command sends one event with names and outcomes only', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'get', 'secret-id', '--json'],
      { env }
    )
    assertContract(result)
    assert.equal(result.telemetry.length, 1)
    const [event] = result.telemetry as [TelemetryEvent]
    const { durationMs, installId, timestamp, ...rest } = event
    assert.ok(Number.isInteger(durationMs) && durationMs >= 0)
    assert.equal(new Date(timestamp).toISOString(), timestamp)
    assert.match(installId ?? '', /^[0-9a-f-]{36}$/)
    // The whole event, so a new field shows up in review.
    assert.deepEqual(rest, {
      eventVersion: 1,
      cli: { name: 'acme', version: '1.2.3' },
      command: 'artifacts get',
      flags: ['json'],
      errorCode: null,
      env: {
        node: process.versions.node,
        os: process.platform,
        arch: process.arch,
        mode: 'noninteractive',
        format: 'json',
        provider: null,
        agent: null,
        agentVersion: null,
      },
    })
    assert.ok(!JSON.stringify(event).includes('secret-id'))
  })

  test('the notice shows once and the installation ID is kept', async () => {
    const first = await invoke(cli, ['artifacts', 'ls'], { env })
    assert.match(first.stderr, /acme: this CLI sends usage data/)
    assert.match(first.stderr, /acme telemetry disable/)
    const second = await invoke(cli, ['artifacts', 'ls'], { env })
    assert.doesNotMatch(second.stderr, /usage data/)
    assert.equal(second.telemetry[0]?.installId, first.telemetry[0]?.installId)
    const state = JSON.parse(await readFile(file(), 'utf8'))
    assert.equal(state.notice, true)
    assert.equal(state.installId, first.telemetry[0]?.installId)
  })

  test('a choice saved while the command runs is kept', async () => {
    const result = await invoke(cli, ['racer'], { env })
    assert.equal(result.exitCode, 0)
    const state = JSON.parse(await readFile(file(), 'utf8'))
    assert.equal(state.telemetry, 'disabled')
    assert.equal(state.notice, true)
    assert.equal(state.installId, result.telemetry[0]?.installId)
  })

  test('the notice links the docs page', async () => {
    const documented = withTelemetry({ sender, docs: 'https://example.com/t' })
    const result = await invoke(documented, ['artifacts', 'ls'], { env })
    assert.match(result.stderr, /Details: https:\/\/example\.com\/t/)
  })

  test('without a state directory, the notice repeats and installId is null', async () => {
    for (let run = 0; run < 2; run++) {
      const result = await invoke(cli, ['artifacts', 'ls'], {})
      assert.match(result.stderr, /usage data/)
      assert.equal(result.telemetry[0]?.installId, null)
    }
  })

  test('an unwritable state directory leaves installId null', async () => {
    await mkdir(join(file(), '..'), { recursive: true })
    await chmod(join(file(), '..'), 0o500)
    try {
      const result = await invoke(cli, ['artifacts', 'ls'], { env })
      assert.equal(result.exitCode, 0)
      assert.equal(result.telemetry[0]?.installId, null)
    } finally {
      await chmod(join(file(), '..'), 0o700)
    }
  })

  test('errors, help, and unknown commands are reported', async () => {
    const failed = await invoke(cli, ['artifacts', 'get', 'missing'], { env })
    assert.equal(failed.telemetry[0]?.errorCode, 'not_found')

    const help = await invoke(cli, ['artifacts', 'put', '--help'], { env })
    assert.equal(help.telemetry[0]?.command, 'artifacts put')
    assert.deepEqual(help.telemetry[0]?.flags, ['help'])

    const unknown = await invoke(cli, ['artifacts', 'nope'], { env })
    assert.equal(unknown.telemetry[0]?.command, 'artifacts')
    assert.equal(unknown.telemetry[0]?.errorCode, 'invalid_input')
  })

  test('command flag names are recorded without values', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', 'a.txt', '--network=calibration', '--dry-run'],
      { env: { ...env, ACME_PRIVATE_KEY: 'k' } }
    )
    assert.deepEqual(result.telemetry[0]?.flags, ['dry-run', 'network'])
    assert.ok(!JSON.stringify(result.telemetry).includes('calibration'))
  })

  test('agent and CI fields', async () => {
    const result = await invoke(cli, ['artifacts', 'ls'], {
      env: { ...env, CODEX_THREAD_ID: 'thread-1', CI: '1' },
    })
    const [event] = result.telemetry as [TelemetryEvent]
    assert.equal(event.env.agent, 'codex')
    assert.equal(event.env.agentVersion, null)
    assert.equal(event.env.mode, 'ci')
    assert.equal(event.env.format, 'json')
    assert.ok(!JSON.stringify(event).includes('thread-1'))
  })

  test('CI sends and saves no installation ID', async () => {
    const result = await invoke(cli, ['artifacts', 'ls'], {
      env: { ...env, CI: 'true', GITHUB_ACTIONS: 'true' },
    })
    assert.equal(result.telemetry[0]?.env.provider, 'github_actions')
    assert.equal(result.telemetry[0]?.installId, null)
    assert.match(result.stderr, /usage data/)
    assert.equal(
      JSON.parse(await readFile(file(), 'utf8')).installId,
      undefined
    )
  })

  test('a saved choice counts as having seen the notice', async () => {
    await invoke(cli, ['telemetry', 'enable'], { env })
    const result = await invoke(cli, ['artifacts', 'ls'], { env })
    assert.equal(result.telemetry.length, 1)
    assert.doesNotMatch(result.stderr, /usage data/)
  })

  test('the agent version comes from AI_AGENT', async () => {
    const result = await invoke(cli, ['artifacts', 'ls'], {
      env: { ...env, AI_AGENT: 'claude-code_2-1-299_agent' },
    })
    assert.equal(result.telemetry[0]?.env.agent, 'claude-code')
    assert.equal(result.telemetry[0]?.env.agentVersion, '2-1-299')

    const forced = await invoke(cli, ['artifacts', 'ls', '--agent'], { env })
    assert.equal(forced.telemetry[0]?.env.agent, 'unknown')
    assert.equal(forced.telemetry[0]?.env.agentVersion, null)
  })

  test('opt-outs send nothing and show no notice', async () => {
    for (const vars of [{ DO_NOT_TRACK: '1' }, { ACME_TELEMETRY: '0' }]) {
      const result = await invoke(cli, ['artifacts', 'ls'], {
        env: { ...env, ...vars },
      })
      assert.deepEqual(result.telemetry, [])
      assert.doesNotMatch(result.stderr, /usage data/)
    }
  })

  test('log mode prints the event instead of sending it', async () => {
    const result = await invoke(cli, ['artifacts', 'ls'], {
      env: { ...env, ACME_TELEMETRY: 'log' },
    })
    assert.deepEqual(result.telemetry, [])
    assert.match(result.stderr, /acme: telemetry event \{"eventVersion":1,/)
  })

  test('nothing is sent when the sandbox has no network', async () => {
    const result = await invoke(cli, ['artifacts', 'ls'], {
      env: { ...env, CODEX_SANDBOX_NETWORK_DISABLED: '1' },
    })
    assert.deepEqual(result.telemetry, [])
  })

  test('an interrupted command sends nothing', async () => {
    const controller = new AbortController()
    const pending = invoke(cli, ['operations', 'wait'], {
      env,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort('SIGTERM'), 20)
    const result = await pending
    assert.equal(result.signal, 'SIGTERM')
    assert.deepEqual(result.telemetry, [])
  })

  test('a CLI without telemetry sends nothing and has no telemetry commands', async () => {
    const result = await invoke(base, ['telemetry', 'status'], { env })
    assert.deepEqual(result.telemetry, [])
    assert.equal(
      (assertContract(result).error as { code: string }).code,
      'invalid_input'
    )
  })
})

describe('telemetry commands', () => {
  test('status reports the resolved state and sends no event', async () => {
    const result = await invoke(cli, ['telemetry', 'status', '--json'], {
      env: { ...env, DO_NOT_TRACK: '1' },
    })
    assert.deepEqual(assertContract(result).data, {
      enabled: false,
      optedOut: true,
      source: 'env',
      variable: 'DO_NOT_TRACK',
    })
    assert.deepEqual(result.telemetry, [])
  })

  test('status in human mode', async () => {
    const result = await invoke(cli, ['telemetry', 'status'], {
      env,
      tty: true,
    })
    assert.equal(result.stdout, 'Telemetry is on (default).\n')
    assert.doesNotMatch(result.stderr, /usage data/)
  })

  test('disable saves the choice and later commands send nothing', async () => {
    const disabled = await invoke(cli, ['telemetry', 'disable', '--json'], {
      env,
    })
    assert.deepEqual(assertContract(disabled).data, {
      enabled: false,
      optedOut: true,
      source: 'config',
    })
    assert.deepEqual(disabled.telemetry, [])
    assert.equal(
      JSON.parse(await readFile(file(), 'utf8')).telemetry,
      'disabled'
    )

    const after = await invoke(cli, ['artifacts', 'ls'], { env })
    assert.deepEqual(after.telemetry, [])

    const enabled = await invoke(cli, ['telemetry', 'enable', '--json'], {
      env,
    })
    assert.equal(
      (assertContract(enabled).data as { enabled: boolean }).enabled,
      true
    )
  })

  test('enable reports an environment opt-out that still applies', async () => {
    const result = await invoke(cli, ['telemetry', 'enable', '--json'], {
      env: { ...env, DO_NOT_TRACK: '1' },
    })
    assert.equal(
      (assertContract(result).data as { optedOut: boolean }).optedOut,
      true
    )
  })

  test('disable without a state directory is state_unwritable', async () => {
    const result = await invoke(cli, ['telemetry', 'disable', '--json'], {})
    assert.equal(
      (assertContract(result).error as { code: string }).code,
      'state_unwritable'
    )
  })
})

describe('telemetry variable', () => {
  test('root help lists <PREFIX>_TELEMETRY only with a telemetry option', async () => {
    const help = await invoke(cli, ['--help'], { env, tty: true })
    assert.match(
      help.stdout,
      / {2}ACME_TELEMETRY +Turn usage telemetry on or off/
    )
    const plain = await invoke(base, ['--help'], { env, tty: true })
    assert.doesNotMatch(plain.stdout, /ACME_TELEMETRY/)
  })
})

describe('ctx.telemetry()', () => {
  test('returns the status and does not count as the notice', async () => {
    const result = await invoke(cli, ['probe', '--json'], { env })
    assert.deepEqual(assertContract(result).data, {
      enabled: true,
      optedOut: false,
      source: 'default',
    })
    assert.match(result.stderr, /usage data/)
  })

  test('works without a telemetry option', async () => {
    const plain = defineCli({
      ...base.options,
      commands: [...base.options.commands, probe],
    })
    const result = await invoke(plain, ['probe', '--json'], {
      env: { DO_NOT_TRACK: '1' },
    })
    assert.deepEqual(assertContract(result).data, {
      enabled: false,
      optedOut: true,
      source: 'unconfigured',
      variable: 'DO_NOT_TRACK',
    })
  })
})

describe('telemetry sender process', () => {
  /** Runs one invocation with the real sender and returns its stderr. */
  async function run(args: string[], vars: Env): Promise<string> {
    let stderr = ''
    await cli.execute(args, {
      env: { ...env, PATH: process.env.PATH, ...vars },
      stdin: Readable.from([]),
      stdout: {
        write(_chunk, callback) {
          callback?.()
          return true
        },
      },
      stderr: {
        write(chunk, callback) {
          stderr += chunk
          callback?.()
          return true
        },
      },
    })
    return stderr
  }

  test('with --debug, waits for the sender, which receives the event', async () => {
    const out = join(home, 'events.ndjson')
    await run(['artifacts', 'ls', '--debug'], { ACME_TEST_TELEMETRY_OUT: out })
    const event = JSON.parse(await readFile(out, 'utf8')) as TelemetryEvent
    assert.equal(event.command, 'artifacts ls')
    assert.deepEqual(event.flags, ['debug'])
  })

  test('with --debug, prints sender errors', async () => {
    const stderr = await run(['artifacts', 'ls', '--debug'], {})
    assert.match(
      stderr,
      /debug: telemetry sender failed: .*ACME_TEST_TELEMETRY_OUT is not set/
    )
  })

  test('without --debug, the detached sender still delivers the event', async () => {
    const out = join(home, 'events.ndjson')
    await run(['artifacts', 'ls'], { ACME_TEST_TELEMETRY_OUT: out })
    let text = ''
    for (let attempt = 0; attempt < 100 && !text; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      text = await readFile(out, 'utf8').catch(() => '')
    }
    assert.equal((JSON.parse(text) as TelemetryEvent).command, 'artifacts ls')
  })
})
