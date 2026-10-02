import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as z from 'zod'
import {
  type AnyCommand,
  defineCli,
  defineCommand,
  detectAgent,
} from '../src/index.ts'
import { fromJsonSchema } from '../src/json-schema.ts'
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
    assert.equal(detectAgent({ CODEX_THREAD_ID: 't1' }), 'codex')
    assert.equal(
      detectAgent({ AI_AGENT: '0', CI: 'true', TERM: 'dumb' }),
      false
    )
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
  test('agents get the first progress line and no status-line escapes', async () => {
    const result = await invoke(
      (await import('./fixtures/cli.ts')).cli,
      ['artifacts', 'put', 'a'],
      { env: { ACME_PRIVATE_KEY: 'k', AI_AGENT: 'codex' }, tty: true }
    )
    assert.equal(result.stderr, 'acme: upload: Uploading a\n')
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
