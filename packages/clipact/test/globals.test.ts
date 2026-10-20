import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as z from 'zod'
import {
  type Context,
  defineCli,
  defineCommand,
  defineGlobals,
  defineHandler,
  type Handler,
} from '../src/index.ts'
import {
  assertContract,
  assertDefinitions,
  globalsSchema,
  invoke,
} from '../src/testing.ts'

const globals = defineGlobals({
  input: z.object({
    apiUrl: z.url().default('https://api.acme.dev').describe('API endpoint'),
    retries: z.number().int().min(0).default(3).describe('Request retries'),
    verbose: z.boolean().default(false).describe('Log requests'),
    regions: z.array(z.string()).default([]).describe('Regions to query'),
    token: z.string().optional().describe('Service token'),
  }),
  env: {
    apiUrl: 'ACME_API_URL',
    retries: 'ACME_RETRIES',
    verbose: 'ACME_VERBOSE',
    regions: 'ACME_REGIONS',
    token: 'ACME_SERVICE_TOKEN',
  },
  secrets: ['token'],
})

const show = defineCommand({
  name: 'show',
  description: 'Show the globals',
  readOnly: true,
  handler: async () => ({ default: showHandler }),
})

const showHandler: Handler = defineHandler(show, (ctx) => {
  const { token, ...rest } = globals.get(ctx)
  return ctx.ok({ ...rest, hasToken: token !== undefined })
})

const cli = defineCli({
  name: 'acme',
  version: '1.0.0',
  globals,
  commands: [show],
})

/** Runs `acme show` and returns the asserted `data`. */
async function showWith(env: Record<string, string>) {
  const result = await invoke(cli, ['show'], { env })
  const json = assertContract(result)
  assert.ok('data' in json, result.stdout)
  return json.data as Record<string, unknown>
}

/** Runs a command that should fail and returns the error body. */
async function errorOf(args: string[], env: Record<string, string>) {
  const result = await invoke(cli, args, { env })
  const json = assertContract(result)
  assert.ok('error' in json, result.stdout)
  return json.error as {
    code: string
    message: string
    details: { path: string; source?: string; message: string }[]
  }
}

describe('globals', () => {
  test('use schema defaults when no variable is set', async () => {
    assert.deepEqual(await showWith({}), {
      apiUrl: 'https://api.acme.dev',
      retries: 3,
      verbose: false,
      regions: [],
      hasToken: false,
    })
  })

  test('convert environment values to the field types', async () => {
    assert.deepEqual(
      await showWith({
        ACME_API_URL: 'https://staging.acme.dev',
        ACME_RETRIES: '5',
        ACME_VERBOSE: '1',
        ACME_REGIONS: 'eu, us',
        ACME_SERVICE_TOKEN: 's3cret',
      }),
      {
        apiUrl: 'https://staging.acme.dev',
        retries: 5,
        verbose: true,
        regions: ['eu', 'us'],
        hasToken: true,
      }
    )
  })

  test('report invalid values with the variable as the path', async () => {
    const error = await errorOf(['show'], {
      ACME_API_URL: 'nope',
      ACME_VERBOSE: 'maybe',
    })
    assert.equal(error.code, 'invalid_input')
    assert.deepEqual(
      error.details.map(({ path, source }) => ({ path, source })),
      [
        { path: 'ACME_VERBOSE', source: 'env:ACME_VERBOSE' },
        { path: 'ACME_API_URL', source: 'env:ACME_API_URL' },
      ]
    )
    assert.match(error.message, /^ACME_VERBOSE: /)
  })

  test('report invalid globals together with invalid framework variables', async () => {
    const error = await errorOf(['show'], {
      ACME_OUTPUT: 'yaml',
      ACME_RETRIES: 'many',
    })
    assert.deepEqual(
      error.details.map((issue) => issue.path),
      ['ACME_OUTPUT', 'ACME_RETRIES']
    )
  })

  test('explain how to set a missing required global', async () => {
    const required = defineGlobals({
      input: z.object({ region: z.string().describe('Region') }),
      env: { region: 'ACME_REGION' },
    })
    const command = defineCommand({
      name: 'x',
      description: 'X',
      handler: async () => ({ default: undefined }),
    })
    const strict = defineCli({
      name: 'acme',
      version: '1.0.0',
      globals: required,
      commands: [command],
    })
    const json = assertContract(await invoke(strict, ['x']))
    assert.deepEqual((json.error as { details: unknown }).details, [
      { path: 'ACME_REGION', message: 'Required; set ACME_REGION' },
    ])
  })

  test('are ignored by help and built-in commands', async () => {
    const env = { ACME_RETRIES: 'many' }
    for (const args of [['--help'], ['show', '--help'], ['--version']]) {
      const result = await invoke(cli, args, { env })
      assert.equal(result.exitCode, 0, args.join(' '))
    }
    const list = assertContract(
      await invoke(cli, ['schema', '--list'], { env })
    )
    assert.ok('data' in list)
  })

  test('the telemetry commands ignore invalid globals', async () => {
    const tracked = defineCli({
      name: 'acme',
      version: '1.0.0',
      globals,
      commands: [show],
      telemetry: { sender: 'file:///telemetry.js' },
    })
    const env = { ACME_RETRIES: 'many', DO_NOT_TRACK: '1' }
    const status = await invoke(tracked, ['telemetry', 'status', '--json'], {
      env,
    })
    assert.equal(status.exitCode, 0, status.stdout)
    const failed = assertContract(await invoke(tracked, ['show'], { env }))
    assert.equal((failed.error as { code: string }).code, 'invalid_input')
  })

  test('--debug lists each global and its source, redacting secrets', async () => {
    const result = await invoke(cli, ['show', '--debug'], {
      env: { ACME_RETRIES: '5', ACME_SERVICE_TOKEN: 's3cret' },
    })
    assert.equal(result.exitCode, 0)
    assert.match(
      result.stderr,
      /debug: globals\n {2}apiUrl = "https:\/\/api.acme.dev" \(default\)\n {2}retries = 5 \(env:ACME_RETRIES\)/
    )
    assert.match(
      result.stderr,
      /token = <redacted> \(env:ACME_SERVICE_TOKEN\)\ndebug: input for show/
    )
    assert.doesNotMatch(result.stderr, /s3cret/)
  })

  test('invoke reads only its env, never process.env', async () => {
    process.env.ACME_RETRIES = '9'
    try {
      assert.equal((await showWith({})).retries, 3)
    } finally {
      delete process.env.ACME_RETRIES
    }
  })

  test('get() throws for a context without these globals', () => {
    assert.throws(
      () => globals.get({} as Context<undefined, undefined>),
      /globals\.get\(\) needs the context of a CLI defined with these globals/
    )
  })

  test('defineGlobals rejects a secret without an env mapping', () => {
    assert.throws(
      () =>
        defineGlobals({
          input: z.object({ key: z.string() }),
          env: {} as { key: string },
          secrets: ['key'],
        }),
      /Secret global "key" needs an env mapping/
    )
  })

  test('defineCli rejects a global that uses a framework variable', () => {
    const clash = defineGlobals({
      input: z.object({ output: z.string().optional() }),
      env: { output: 'ACME_OUTPUT' },
    })
    assert.throws(
      () =>
        defineCli({ name: 'acme', version: '1', globals: clash, commands: [] }),
      /Global variable ACME_OUTPUT clashes with a framework variable of "acme"/
    )
  })

  test('defineCli rejects a global that uses <PREFIX>_CONFIG_DIR', () => {
    const clash = defineGlobals({
      input: z.object({ configDir: z.string().optional() }),
      env: { configDir: 'ACME_CONFIG_DIR' },
    })
    assert.throws(
      () =>
        defineCli({ name: 'acme', version: '1', globals: clash, commands: [] }),
      /Global variable ACME_CONFIG_DIR clashes with a framework variable/
    )
  })

  test('defineCli rejects a global that uses <PREFIX>_TELEMETRY', () => {
    const clash = defineGlobals({
      input: z.object({ telemetry: z.string().optional() }),
      env: { telemetry: 'ACME_TELEMETRY' },
    })
    assert.throws(
      () =>
        defineCli({ name: 'acme', version: '1', globals: clash, commands: [] }),
      /Global variable ACME_TELEMETRY clashes with a framework variable/
    )
  })
})

describe('globals help and discovery', () => {
  test('root help lists globals, then framework variables', async () => {
    const result = await invoke(cli, ['--help'])
    assert.match(
      result.stdout,
      /Environment:\n {2}ACME_API_URL +API endpoint \(default: "https:\/\/api.acme.dev"\)\n/
    )
    assert.match(
      result.stdout,
      / {2}ACME_SERVICE_TOKEN +Service token \(secret\)\n/
    )
    assert.match(
      result.stdout,
      / {2}ACME_OUTPUT +Default output format: json or human\n {2}ACME_AGENT +Force or disable agent mode/
    )
  })

  test('root help lists framework variables without globals', async () => {
    const plain = defineCli({ name: 'my-tool', version: '1', commands: [show] })
    const result = await invoke(plain, ['--help'])
    assert.match(result.stdout, /Environment:\n {2}MY_TOOL_OUTPUT /)
  })

  test('command help points to the global variables', async () => {
    const human = await invoke(cli, ['show', '--help'])
    assert.match(
      human.stdout,
      /\n\nGlobal environment variables: acme --help\n/
    )
    const agent = await invoke(cli, ['show', '--help'], {
      env: { AI_AGENT: 'test' },
    })
    assert.match(
      agent.stdout,
      /Global environment variables: acme --help\n\nOutput is one JSON object/
    )
  })

  test('schema --list publishes framework variables and globals', async () => {
    const json = assertContract(await invoke(cli, ['schema', '--list']))
    const data = json.data as Record<string, unknown>
    assert.deepEqual(Object.keys(data), [
      'name',
      'version',
      'commands',
      'env',
      'globals',
      'result',
    ])
    assert.deepEqual(data.env, {
      output: 'ACME_OUTPUT',
      agent: 'ACME_AGENT',
      telemetry: 'ACME_TELEMETRY',
      config: 'ACME_CONFIG_DIR',
    })
    const block = data.globals as {
      env: Record<string, string>
      secrets: string[]
      input: { properties: Record<string, Record<string, unknown>> }
    }
    assert.equal(block.env.apiUrl, 'ACME_API_URL')
    assert.deepEqual(block.secrets, ['token'])
    assert.equal(block.input.properties.retries?.default, 3)
    assert.deepEqual(globalsSchema(cli), block)
  })

  test('globalsSchema is undefined without globals', () => {
    const plain = defineCli({ name: 'acme', version: '1', commands: [show] })
    assert.equal(globalsSchema(plain), undefined)
  })
})

describe('globals definitions', () => {
  test('assertDefinitions accepts valid globals', () => {
    assertDefinitions(cli)
  })

  test('assertDefinitions reports a field without an env mapping', () => {
    const partial = defineGlobals({
      input: z.object({ a: z.string(), b: z.string() }),
      env: { a: 'ACME_A' } as { a: string; b: string },
    })
    const invalid = defineCli({
      name: 'acme',
      version: '1',
      globals: partial,
      commands: [show],
    })
    assert.throws(
      () => assertDefinitions(invalid),
      /"globals": field "b" needs an env mapping/
    )
  })

  test('assertDefinitions reports a variable shared with a command', () => {
    const command = defineCommand({
      name: 'x',
      description: 'X',
      input: z.object({ url: z.string().optional() }),
      env: { url: 'ACME_API_URL' },
      handler: async () => ({ default: undefined }),
    })
    const shared = defineCli({
      name: 'acme',
      version: '1',
      globals,
      commands: [command],
    })
    assert.throws(
      () => assertDefinitions(shared),
      /"x": ACME_API_URL of "url" is also the global "apiUrl"/
    )
  })

  test('assertDefinitions reports a command that uses a framework variable', () => {
    const command = defineCommand({
      name: 'x',
      description: 'X',
      input: z.object({ who: z.string().optional() }),
      env: { who: 'ACME_AGENT' },
      handler: async () => ({ default: undefined }),
    })
    const shared = defineCli({
      name: 'acme',
      version: '1',
      commands: [command],
    })
    assert.throws(
      () => assertDefinitions(shared),
      /"x": ACME_AGENT of "who" is also a framework variable/
    )
  })
})
