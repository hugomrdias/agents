import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, test } from 'node:test'
import * as z from 'zod'
import { identifyAgent } from '../src/agent.ts'
import {
  type AnyCommand,
  defineCli,
  defineCommand,
  detectAgent,
} from '../src/index.ts'
import { fromJsonSchema } from '../src/json-schema.ts'
import {
  formatElapsed,
  HEARTBEAT_FIRST_MS,
  HEARTBEAT_MS,
  Session,
} from '../src/session.ts'
import { resolveSpec, toFlag } from '../src/spec.ts'
import { invoke } from '../src/testing.ts'

const noop = () => Promise.resolve({})

describe('detectAgent', () => {
  test('prefers AI_AGENT and AGENT over vendor variables', () => {
    assert.equal(
      detectAgent({ AI_AGENT: 'claude-code', CODEX_CI: '1' }),
      'claude-code'
    )
    assert.equal(detectAgent({ AGENT: 'amp' }), 'amp')
    assert.equal(detectAgent({ AI_AGENT: '1' }), 'unknown')
    assert.equal(
      detectAgent({ AI_AGENT: 'claude-code_2-1-299_agent' }),
      'claude-code'
    )
    assert.equal(detectAgent({ CODEX_THREAD_ID: 't1' }), 'codex')
    assert.equal(
      detectAgent({ AI_AGENT: '0', CI: 'true', TERM: 'dumb' }),
      false
    )
  })
})

describe('identifyAgent', () => {
  test('splits <name>_<version>_agent into the name and the version', () => {
    assert.deepEqual(identifyAgent({ AI_AGENT: 'claude-code_2-1-299_agent' }), {
      agent: 'claude-code',
      version: '2-1-299',
    })
    assert.deepEqual(identifyAgent({ AGENT: 'amp' }), { agent: 'amp' })
    assert.deepEqual(identifyAgent({ AI_AGENT: 'my_tool' }), {
      agent: 'my_tool',
    })
    assert.deepEqual(identifyAgent({ GEMINI_CLI: '1' }), {
      agent: 'gemini-cli',
    })
    assert.equal(identifyAgent({}), undefined)
  })
})

describe('definitions', () => {
  test('defineCommand rejects contradictions', () => {
    assert.throws(
      () =>
        defineCommand({
          name: 'x',
          description: '',
          readOnly: true,
          confirm: 'Sure?',
          handler: noop,
        }),
      /cannot be readOnly and require confirmation/
    )
    assert.throws(
      () =>
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ token: z.string() }),
          secrets: ['token'],
          handler: noop,
        }),
      /needs an env mapping/
    )
  })

  const cases: [string, () => AnyCommand, RegExp][] = [
    [
      'array positional before the last',
      () =>
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ a: z.array(z.string()), b: z.string() }),
          positionals: ['a', 'b'],
          handler: noop,
        }),
      /only the last positional may be an array/,
    ],
    [
      'required after optional',
      () =>
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ a: z.string().optional(), b: z.string() }),
          positionals: ['a', 'b'],
          handler: noop,
        }),
      /required positional "b" follows an optional one/,
    ],
    [
      'unknown positional',
      () =>
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ a: z.string() }),
          positionals: ['b' as 'a'],
          handler: noop,
        }),
      /"b" is not an input field/,
    ],
    [
      'framework flag clash',
      () =>
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ dryRun: z.boolean() }),
          handler: noop,
        }),
      /clashes with the framework flag --dry-run/,
    ],
    [
      'two fields with one flag',
      () =>
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ rpcUrl: z.string(), rpcURL: z.string() }),
          handler: noop,
        }),
      /fields "rpcUrl" and "rpcURL" both use --rpc-url/,
    ],
  ]
  for (const [name, create, message] of cases) {
    test(`resolveSpec rejects ${name}`, () => {
      assert.throws(() => resolveSpec(create(), 'x'), message)
    })
  }

  test('a definition error becomes internal_error', async () => {
    const cli = defineCli({
      name: 'bad',
      version: '0.0.0',
      commands: [
        defineCommand({
          name: 'x',
          description: '',
          input: z.object({ help: z.boolean() }),
          handler: noop,
        }),
      ],
    })
    const result = await invoke(cli, ['x'])
    assert.match(
      (result.json?.error as { message: string } | undefined)?.message ?? '',
      /field "help" clashes with the framework flag --help/
    )
  })
})

describe('toFlag', () => {
  test('splits camelCase and keeps acronyms as one word', () => {
    assert.deepEqual(
      ['privateKey', 'rpcURL', 'chainID', 'URLPath', 'v2Name', 'name'].map(
        toFlag
      ),
      ['private-key', 'rpc-url', 'chain-id', 'url-path', 'v2-name', 'name']
    )
  })
})

describe('progress', () => {
  test('agents get every event and no status-line escapes', async () => {
    const result = await invoke(
      (await import('./fixtures/cli.ts')).cli,
      ['artifacts', 'put', 'a'],
      { env: { ACME_PRIVATE_KEY: 'k', AI_AGENT: 'codex' }, tty: true }
    )
    assert.equal(
      result.stderr,
      'acme: upload: Uploading a\nacme: upload: Uploaded a\nacme: commit: Committing a\n'
    )
  })

  /** A session writing stderr to an array, for the given terminal and agent. */
  function session(options: { tty: boolean; agent: string | false }) {
    const lines: string[] = []
    const stream = Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(String(chunk))
          callback()
        },
      }),
      { isTTY: options.tty }
    )
    const io = { env: {}, stdin: process.stdin, stdout: stream, stderr: stream }
    const mode = {
      format: options.agent ? ('json' as const) : ('human' as const),
      agent: options.agent,
      interactive: false,
    }
    return {
      lines,
      session: new Session(
        { name: 'acme', version: '1.0.0', commands: [] },
        io,
        mode,
        false
      ),
    }
  }

  test('repeats the latest event with its elapsed time while quiet', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { session: s, lines } = session({ tty: false, agent: 'codex' })
    s.progress({ phase: 'commit', message: 'Waiting' })
    t.mock.timers.tick(HEARTBEAT_FIRST_MS - 1)
    assert.deepEqual(lines, ['acme: commit: Waiting\n'])
    t.mock.timers.tick(1)
    t.mock.timers.tick(HEARTBEAT_MS)
    assert.deepEqual(lines.slice(1), [
      'acme: commit: Waiting (15 s)\n',
      'acme: commit: Waiting (45 s)\n',
    ])
    await s.render({ data: {} })
    t.mock.timers.tick(HEARTBEAT_MS * 2)
    assert.equal(lines.at(-1), '{"data":{}}\n')
  })

  test('any stderr line restarts the quiet time', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { session: s, lines } = session({ tty: false, agent: 'codex' })
    s.progress({ phase: 'upload', message: 'Uploading' })
    t.mock.timers.tick(10_000)
    s.log('acme: a note')
    t.mock.timers.tick(10_000)
    assert.equal(lines.length, 2)
    t.mock.timers.tick(5_000)
    assert.equal(lines.at(-1), 'acme: upload: Uploading (25 s)\n')
    s.stop()
  })

  test('a new event resets the elapsed time and the first interval', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { session: s, lines } = session({ tty: false, agent: 'codex' })
    s.progress({ phase: 'upload', message: 'Uploading' })
    t.mock.timers.tick(HEARTBEAT_FIRST_MS)
    s.progress({ phase: 'commit', message: 'Waiting' })
    t.mock.timers.tick(HEARTBEAT_FIRST_MS)
    assert.equal(lines.at(-1), 'acme: commit: Waiting (15 s)\n')
    s.stop()
  })

  test('humans see the elapsed time in the status line', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { session: s, lines } = session({ tty: true, agent: false })
    s.progress({ phase: 'commit', message: 'Waiting' })
    t.mock.timers.tick(HEARTBEAT_FIRST_MS)
    const line = lines.at(-1) ?? ''
    assert.ok(line.startsWith('\r\x1b[2K'))
    assert.ok(line.includes('commit: Waiting (15 s)'))
    s.stop()
  })

  test('formatElapsed uses seconds, then minutes', () => {
    assert.deepEqual([0, 15_000, 59_400, 60_000, 125_000].map(formatElapsed), [
      '0 s',
      '15 s',
      '59 s',
      '1 min',
      '2 min 5 s',
    ])
  })
})

describe('fromJsonSchema', () => {
  const schema = fromJsonSchema({
    type: 'object',
    properties: {
      name: { type: 'string' },
      mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
      tags: { type: 'array', items: { type: 'string' }, default: [] },
    },
    required: ['name'],
    additionalProperties: false,
  })

  test('applies defaults without sharing them between results', async () => {
    const first = await schema['~standard'].validate({ name: 'x' })
    assert.deepEqual(first, { value: { name: 'x', mode: 'a', tags: [] } })
    const second = await schema['~standard'].validate({ name: 'y' })
    assert.notEqual(
      (first as { value: { tags: unknown } }).value.tags,
      (second as { value: { tags: unknown } }).value.tags
    )
  })

  test('reports every issue with its path', async () => {
    const result = await schema['~standard'].validate({
      mode: 'c',
      tags: ['ok', 1],
      extra: true,
    })
    assert.deepEqual(result, {
      issues: [
        { message: 'Unknown field', path: ['extra'] },
        { message: 'Required', path: ['name'] },
        { message: 'Expected one of: a, b', path: ['mode'] },
        { message: 'Expected a string', path: ['tags', 1] },
      ],
    })
  })

  test('exports the same schema as draft 2020-12', () => {
    const json = schema['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    })
    assert.equal(json.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.deepEqual(json.required, ['name'])
  })
})
