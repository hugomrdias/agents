import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, test } from 'node:test'
import {
  type Command,
  defineCli,
  defineCommand,
  defineHandler,
} from '../src/index.ts'
import {
  assertContract,
  assertDefinitions,
  invoke,
  schemas,
} from '../src/testing.ts'
import { cli } from './fixtures/cli.ts'

const KEY = { ACME_PRIVATE_KEY: 'secret-key-value' }

describe('results', () => {
  test('writes one JSON result with defaults, positionals, and next steps', async () => {
    const result = await invoke(cli, ['artifacts', 'put', './a.txt'], {
      env: KEY,
    })
    assert.deepEqual(assertContract(result), {
      ok: true,
      ref: 'ref-2',
      url: 'https://example.com/./a.txt',
      next: [
        {
          by: 'agent',
          command: 'acme artifacts get ref-2',
          description: 'Inspect it',
        },
      ],
    })
    assert.equal(result.exitCode, 0)
  })

  test('converts flag values to the schema types', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', 'a', '--copies', '3', '--tags', 'x', '--tags=y'],
      { env: KEY }
    )
    const json = assertContract(result)
    assert.equal(json.ref, 'ref-3')
    assert.deepEqual(json.tags, ['x', 'y'])
  })

  test('assigns variadic positionals and boolean flags', async () => {
    const result = await invoke(cli, [
      'artifacts',
      'label',
      'id1',
      'a',
      'b',
      '--force',
    ])
    assert.deepEqual(assertContract(result), {
      ok: true,
      id: 'id1',
      labels: ['a', 'b'],
      force: true,
    })
  })

  test('accepts positional fields as flags', async () => {
    const result = await invoke(cli, ['artifacts', 'get', '--id', 'x1'])
    assert.equal(assertContract(result).id, 'x1')
  })

  test('resolves aliases to the canonical command', async () => {
    const result = await invoke(cli, ['publish', 'a'], { env: KEY })
    assert.equal(assertContract(result).ref, 'ref-2')
  })

  test('accepts framework flags before the command path', async () => {
    const result = await invoke(cli, ['--json', 'artifacts', 'get', 'x'])
    assert.equal(assertContract(result).id, 'x')
  })

  test('renders human output and next steps on the right streams', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', 'a', '--format', 'human'],
      {
        env: KEY,
      }
    )
    assert.equal(result.stdout, 'ref: ref-2\nurl: https://example.com/a\n')
    assert.match(
      result.stderr,
      /Next:\n {2}Inspect it\n {4}acme artifacts get ref-2/
    )
    assert.equal(result.exitCode, 0)
  })
})

describe('input validation', () => {
  test('reports every problem at once with field names and sources', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', '--copies', '9', '--entri', 'x', '--no-entry'],
      { env: { ...KEY, ACME_NETWORK: 'testnet' } }
    )
    const json = assertContract(result)
    const error = json.error as {
      code: string
      details: unknown[]
      retryable: boolean
    }
    assert.equal(error.code, 'invalid_input')
    assert.equal(error.retryable, false)
    assert.deepEqual(error.details, [
      {
        path: '--entri',
        source: 'flag',
        message: 'Unknown flag; did you mean --entry?',
      },
      {
        path: 'entry',
        source: 'flag',
        message: '--no-entry is only valid for boolean flags',
      },
      { path: 'path', message: 'Required; pass <path> or --path' },
      {
        path: 'copies',
        source: 'flag',
        message: 'Too big: expected number to be <=5',
      },
      {
        path: 'network',
        source: 'env:ACME_NETWORK',
        message: 'Invalid option: expected one of "mainnet"|"calibration"',
      },
    ])
  })

  test('rejects a value outside the schema range', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', 'a', '--copies', '9'],
      { env: KEY }
    )
    const error = assertContract(result).error as {
      details: unknown[]
      message: string
    }
    assert.deepEqual(error.details, [
      {
        path: 'copies',
        source: 'flag',
        message: 'Too big: expected number to be <=5',
      },
    ])
    assert.equal(error.message, 'copies: Too big: expected number to be <=5.')
  })

  test('rejects extra positionals', async () => {
    const result = await invoke(cli, ['artifacts', 'get', 'a', 'b'])
    const error = assertContract(result).error as { details: unknown[] }
    assert.deepEqual(error.details, [
      { path: 'b', source: 'positional', message: 'Unexpected argument' },
    ])
  })

  test('prints usage for humans and full help for agents on stderr', async () => {
    const human = await invoke(cli, ['artifacts', 'get', '--format', 'human'])
    assert.match(human.stderr, /Usage: acme artifacts get <id>/)
    assert.equal(human.stdout, '')
    const agent = await invoke(cli, ['artifacts', 'get'], {
      env: { AI_AGENT: 'codex' },
    })
    assert.match(agent.stderr, /Full schema: acme schema artifacts get/)
    assertContract(agent)
  })
})

describe('secrets and environment', () => {
  test('reads secrets only from the environment', async () => {
    const result = await invoke(cli, [
      'artifacts',
      'put',
      'a',
      '--private-key',
      'k',
    ])
    const error = assertContract(result).error as { details: unknown[] }
    assert.deepEqual(error.details, [
      {
        path: 'privateKey',
        source: 'flag',
        message: 'Secret values are read only from ACME_PRIVATE_KEY',
      },
    ])
  })

  test('explains how to supply a missing secret', async () => {
    const result = await invoke(cli, ['artifacts', 'put', 'a'])
    const error = assertContract(result).error as { details: unknown[] }
    assert.deepEqual(error.details, [
      { path: 'privateKey', message: 'Required; set ACME_PRIVATE_KEY' },
    ])
  })

  test('redacts secrets in debug output', async () => {
    const result = await invoke(cli, ['artifacts', 'put', 'a', '--debug'], {
      env: KEY,
    })
    assert.match(
      result.stderr,
      /privateKey = <redacted> \(env:ACME_PRIVATE_KEY\)/
    )
    assert.match(result.stderr, /copies = 2 \(default\)/)
    assert.doesNotMatch(result.stderr + result.stdout, /secret-key-value/)
  })
})

describe('--input', () => {
  test('merges JSON from stdin with flags', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', '--input', '-', '--entry', 'i.html'],
      {
        env: KEY,
        stdin: '{"path":"site","copies":4}',
      }
    )
    assert.equal(assertContract(result).ref, 'ref-4')
  })

  test('reads a file and rejects fields given twice', async () => {
    const file = join(tmpdir(), `clipact-input-${process.pid}.json`)
    await writeFile(file, '{"path":"site","copies":4,"privateKey":"k"}')
    const result = await invoke(
      cli,
      ['artifacts', 'put', 'a', '--input', file],
      { env: KEY }
    )
    const error = assertContract(result).error as { details: unknown[] }
    assert.deepEqual(error.details, [
      {
        path: 'path',
        source: 'input',
        message: 'Given both in --input and as an argument',
      },
      {
        path: 'privateKey',
        source: 'input',
        message: 'Secret values are read only from ACME_PRIVATE_KEY',
      },
    ])
  })

  test('rejects stdin used twice', async () => {
    const result = await invoke(
      cli,
      ['artifacts', 'put', '-', '--input', '-'],
      {
        env: KEY,
        stdin: '{}',
      }
    )
    const error = assertContract(result).error as {
      details: { path: string }[]
    }
    assert.ok(error.details.some((issue) => issue.path === '--input'))
  })
})

describe('confirmation and dry runs', () => {
  const mainnet = { ...KEY, ACME_NETWORK: 'mainnet' }

  test('requires --yes without a human and names the user step', async () => {
    const result = await invoke(cli, ['artifacts', 'put', 'my file.txt'], {
      env: mainnet,
    })
    assert.deepEqual(assertContract(result), {
      ok: false,
      error: {
        code: 'confirmation_required',
        message: 'Spends mainnet funds for 2 copies. Confirm with --yes.',
        retryable: false,
        details: { reason: 'Spends mainnet funds for 2 copies.' },
      },
      next: [
        {
          by: 'user',
          command: "acme artifacts put 'my file.txt' --yes",
          description: 'Approve this action, then run it with --yes',
        },
      ],
    })
  })

  test('agent detection never skips confirmation', async () => {
    const result = await invoke(cli, ['artifacts', 'put', 'a'], {
      env: { ...mainnet, CLAUDECODE: '1' },
    })
    assert.equal(
      (assertContract(result).error as { code: string }).code,
      'confirmation_required'
    )
  })

  test('runs with --yes or --dry-run', async () => {
    const yes = await invoke(cli, ['artifacts', 'put', 'a', '--yes'], {
      env: mainnet,
    })
    assert.equal(assertContract(yes).ok, true)
    const dry = await invoke(cli, ['artifacts', 'put', 'a', '--dry-run'], {
      env: mainnet,
    })
    assert.equal(assertContract(dry).ref, 'dry-run')
  })

  test('rejects --yes and --dry-run on commands that do not support them', async () => {
    const result = await invoke(cli, [
      'artifacts',
      'get',
      'a',
      '--yes',
      '--dry-run',
    ])
    const error = assertContract(result).error as {
      details: { path: string }[]
    }
    assert.deepEqual(
      error.details.map((issue) => issue.path),
      ['--yes', '--dry-run']
    )
  })
})

describe('errors', () => {
  test('renders a CliError with its next steps', async () => {
    const result = await invoke(cli, ['artifacts', 'put', 'broke'], {
      env: KEY,
    })
    assert.deepEqual(assertContract(result), {
      ok: false,
      error: {
        code: 'insufficient_funds',
        message: 'The payer cannot cover the lockup.',
        retryable: false,
      },
      next: [
        { by: 'user', command: 'acme auth fund', description: 'Add funds' },
      ],
    })
    assert.match(result.stderr, /^acme: The payer cannot cover the lockup\.\n$/)
  })

  test('marks transient errors retryable only for safe commands', async () => {
    const read = await invoke(cli, ['artifacts', 'get', 'busy'])
    assert.deepEqual(assertContract(read).error, {
      code: 'rate_limited',
      message: 'Slow down.',
      retryable: true,
      retryAfterSeconds: 3,
    })
    const write = await invoke(cli, ['artifacts', 'put', 'slow'], { env: KEY })
    assert.equal(
      (assertContract(write).error as { retryable: boolean }).retryable,
      false
    )
  })

  test('maps third-party errors with the lazy mapError hook', async () => {
    const result = await invoke(cli, ['artifacts', 'get', 'missing'])
    assert.deepEqual(assertContract(result).error, {
      code: 'not_found',
      message: 'No artifact missing',
      retryable: false,
    })
  })

  test('turns unexpected errors into internal_error', async () => {
    const result = await invoke(cli, ['artifacts', 'get', 'boom'])
    const json = assertContract(result)
    assert.equal((json.error as { code: string }).code, 'internal_error')
    assert.doesNotMatch(result.stderr, /at .*get\.run\.ts/)
    const debug = await invoke(cli, ['artifacts', 'get', 'boom', '--debug'])
    assert.match(debug.stderr, /get\.run\.ts/)
  })

  test('strict mode flags contract violations', async () => {
    for (const [kind, message] of [
      ['output', /output does not match the schema/],
      ['code', /"undeclared" is not declared/],
      ['retryable', /neither readOnly nor idempotent/],
    ] as const) {
      const result = await invoke(cli, ['broken', kind])
      const error = assertContract(result).error as {
        code: string
        message: string
      }
      assert.equal(error.code, 'internal_error')
      assert.match(error.message, message)
    }
  })

  test('suggests the closest command', async () => {
    const result = await invoke(cli, ['artifact', 'put'])
    const json = assertContract(result)
    assert.equal(
      (json.error as { message: string }).message,
      'Unknown command "acme artifact". Did you mean "artifacts"?'
    )
    assert.deepEqual(json.next, [
      {
        by: 'agent',
        command: 'acme artifacts --help',
        description: 'Show help for "artifacts"',
      },
      {
        by: 'agent',
        command: 'acme schema --list',
        description: 'List all commands',
      },
    ])
  })

  test('a group without a command is an error for machines and help for humans', async () => {
    const machine = await invoke(cli, ['artifacts'])
    assert.deepEqual(
      (assertContract(machine).error as { details: unknown }).details,
      {
        commands: ['artifacts put', 'artifacts get', 'artifacts label'],
      }
    )
    const human = await invoke(cli, ['artifacts', '--format', 'human'])
    assert.equal(human.exitCode, 0)
    assert.match(human.stdout, /Commands:\n {2}artifacts put/)
  })
})

describe('modes', () => {
  test('uses human output on a terminal and JSON for agents', async () => {
    const human = await invoke(cli, ['artifacts', 'get', 'x'], { tty: true })
    assert.equal(human.stdout, 'id: x\nsize: 42\n')
    const agent = await invoke(cli, ['artifacts', 'get', 'x'], {
      tty: true,
      env: { GEMINI_CLI: '1' },
    })
    assert.equal(assertContract(agent).id, 'x')
    const forced = await invoke(cli, ['artifacts', 'get', 'x', '--no-agent'], {
      tty: true,
      env: { GEMINI_CLI: '1' },
    })
    assert.equal(forced.stdout, 'id: x\nsize: 42\n')
  })

  test('honors framework variables and rejects invalid values', async () => {
    const human = await invoke(cli, ['artifacts', 'get', 'x'], {
      env: { ACME_OUTPUT: 'human' },
    })
    assert.equal(human.stdout, 'id: x\nsize: 42\n')
    const invalid = await invoke(cli, ['artifacts', 'get', 'x'], {
      env: { ACME_OUTPUT: 'yaml', ACME_AGENT: 'maybe' },
    })
    assert.deepEqual(
      (assertContract(invalid).error as { details: unknown }).details,
      [
        {
          path: 'ACME_AGENT',
          source: 'env:ACME_AGENT',
          message: 'Expected 1, 0, true, or false',
        },
        {
          path: 'ACME_OUTPUT',
          source: 'env:ACME_OUTPUT',
          message: 'Expected json or human',
        },
      ]
    )
    const help = await invoke(cli, ['--help'], { env: { ACME_OUTPUT: 'yaml' } })
    assert.equal(help.exitCode, 0)
  })

  test('rejects conflicting format flags', async () => {
    const result = await invoke(cli, [
      'artifacts',
      'get',
      'x',
      '--json',
      '--format',
      'human',
    ])
    assert.equal(
      (assertContract(result).error as { code: string }).code,
      'invalid_input'
    )
  })
})

describe('discovery', () => {
  test('prints the version and help without loading handlers', async () => {
    const version = await invoke(cli, ['--version'])
    assert.equal(version.stdout, '1.2.3\n')
    const help = await invoke(cli, ['--help'])
    assert.match(help.stdout, /^acme 1\.2\.3: Example publishing CLI/)
    assert.match(
      help.stdout,
      /artifacts put {2,}Publish a file and return a link/
    )
  })

  test('renders command help in human and agent styles', async () => {
    const human = await invoke(cli, ['artifacts', 'put', '--help'])
    assert.match(
      human.stdout,
      /Usage:\n {2}acme artifacts put <path> \[flags\]/
    )
    assert.match(
      human.stdout,
      /--network <mainnet\|calibration> +Target network \(default: "calibration"; env: ACME_NETWORK\)/
    )
    assert.match(
      human.stdout,
      /ACME_PRIVATE_KEY +Signing key \(secret, required\)/
    )
    assert.match(human.stdout, /Global flags:/)
    const agent = await invoke(cli, ['artifacts', 'put', '-h'], {
      env: { AI_AGENT: '1' },
    })
    assert.match(
      agent.stdout,
      /^acme artifacts put: Publish a file and return a link\n\nExamples:/
    )
    assert.match(
      agent.stdout,
      /Output fields: ref \(string\), url \(string\), tags \(array\)/
    )
    assert.match(agent.stdout, /Error codes: insufficient_funds, invalid_input/)
    assert.match(agent.stdout, /May require confirmation depending on input/)
  })

  test('lists commands and describes one command', async () => {
    const list = assertContract(await invoke(cli, ['schema', '--list']))
    assert.deepEqual(
      (list.commands as { command: string }[]).map((c) => c.command),
      [
        'artifacts put',
        'artifacts get',
        'artifacts label',
        'operations wait',
        'broken',
      ]
    )
    const put = assertContract(
      await invoke(cli, ['schema', 'artifacts', 'put'])
    )
    assert.equal(put.command, 'artifacts put')
    assert.deepEqual(put.positionals, ['path'])
    assert.deepEqual(put.secrets, ['privateKey'])
    assert.deepEqual(put.env, {
      network: 'ACME_NETWORK',
      privateKey: 'ACME_PRIVATE_KEY',
    })
    assert.deepEqual(put.confirm, { when: 'conditional' })
    assert.deepEqual(put.aliases, ['publish'])
    assert.equal((put.input as { type: string }).type, 'object')
  })

  test('schema resolves an alias to the canonical command', async () => {
    const alias = assertContract(await invoke(cli, ['schema', 'publish']))
    const canonical = assertContract(
      await invoke(cli, ['schema', 'artifacts', 'put'])
    )
    assert.deepEqual(alias, canonical)
    const extra = assertContract(
      await invoke(cli, ['schema', 'publish', 'extra'])
    )
    assert.equal((extra.error as { code: string }).code, 'invalid_input')
  })

  test('schema shows help like any command', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await invoke(cli, ['schema', flag])
      assert.equal(result.exitCode, 0, flag)
      assert.match(result.stdout, /^acme schema: JSON Schema for a command/)
      assert.match(
        result.stdout,
        /Usage:\n {2}acme schema \[command\.\.\.\] \[flags\]/
      )
      assert.match(result.stdout, /--list/)
    }
  })

  test('schema describes itself but stays out of command lists', async () => {
    const own = assertContract(await invoke(cli, ['schema', 'schema']))
    assert.equal(own.command, 'schema')
    assert.deepEqual(own.positionals, ['command'])
    assert.equal(own.readOnly, true)
    const list = assertContract(await invoke(cli, ['schema']))
    assert.ok(
      !(list.commands as { command: string }[]).some((c) =>
        c.command.startsWith('schema')
      )
    )
    const help = await invoke(cli, ['--help'])
    const commands = help.stdout.split('Built-in:')[0] as string
    assert.doesNotMatch(commands, /^ {2}schema/m)
    assert.match(help.stdout, /Built-in:\n {2}schema \[command\.\.\.\]/)
  })

  test('schema prints one JSON object, pretty in human mode', async () => {
    const json = await invoke(cli, ['schema', 'artifacts', 'get'])
    assert.equal(json.stdout.trim().split('\n').length, 1)
    assert.equal(json.stderr, '')
    const human = await invoke(cli, [
      'schema',
      'artifacts',
      'get',
      '--format',
      'human',
    ])
    assert.equal(human.stdout, `${JSON.stringify(json.json, null, 2)}\n`)
  })

  test('schema rejects unknown commands and flags', async () => {
    const unknown = assertContract(await invoke(cli, ['schema', 'nope']))
    assert.equal(
      (unknown.error as { message: string }).message,
      'Unknown command "acme nope".'
    )
    const flag = assertContract(await invoke(cli, ['schema', '--yes']))
    assert.equal((flag.error as { code: string }).code, 'invalid_input')
  })

  test('a CLI command named schema replaces the built-in', async () => {
    const command: Command = defineCommand({
      name: 'schema',
      description: 'Custom schema',
      handler: async () => ({
        default: defineHandler(command, ({ ok }) => ok({ custom: true })),
      }),
    })
    const custom = defineCli({
      name: 'acme',
      version: '1.0.0',
      commands: [command],
    })
    assert.deepEqual(assertContract(await invoke(custom, ['schema'])), {
      ok: true,
      custom: true,
    })
    const help = await invoke(custom, ['--help'])
    assert.match(help.stdout, /Commands:\n {2}schema +Custom schema/)
  })

  test('schema works with invalid framework variables', async () => {
    const result = await invoke(cli, ['schema', 'artifacts', 'get'], {
      env: { ACME_AGENT: 'maybe' },
    })
    assert.equal(assertContract(result).ok, true)
  })

  test('definitions are valid and schemas are stable', () => {
    assertDefinitions(cli)
    assert.deepEqual(Object.keys(schemas(cli)), [
      'artifacts put',
      'artifacts get',
      'artifacts label',
      'operations wait',
      'broken',
    ])
  })
})

describe('interruption', () => {
  test('reports the checkpoint next steps and the signal to re-raise', async () => {
    const controller = new AbortController()
    const pending = invoke(cli, ['operations', 'wait'], {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort('SIGTERM'), 20)
    const result = await pending
    assert.equal(result.signal, 'SIGTERM')
    assert.deepEqual(result.json, {
      ok: false,
      error: {
        code: 'interrupted',
        message: 'Interrupted by SIGTERM.',
        retryable: false,
      },
      next: [
        {
          by: 'agent',
          command: 'acme operations resume op_1',
          description: 'Resume the operation',
        },
      ],
    })
    assert.match(
      result.stderr,
      /acme: started op_1; if interrupted, run: acme operations resume op_1/
    )
  })
})

describe('input hardening', () => {
  test('accepts only decimal numbers', async () => {
    for (const value of ['0x2', ' 2', '', '2px']) {
      const result = await invoke(
        cli,
        ['artifacts', 'put', 'a', `--copies=${value}`],
        { env: KEY }
      )
      assert.equal(
        (assertContract(result).error as { code: string }).code,
        'invalid_input',
        value
      )
    }
    const scientific = await invoke(
      cli,
      ['artifacts', 'put', 'a', '--copies', '3e0'],
      { env: KEY }
    )
    assert.equal(assertContract(scientific).ref, 'ref-3')
  })

  test('rejects control characters on the command line but not in --input', async () => {
    const flag = await invoke(cli, ['artifacts', 'put', 'a\u001b[31m'], {
      env: KEY,
    })
    assert.deepEqual(
      (assertContract(flag).error as { details: unknown }).details,
      [
        {
          path: 'path',
          source: 'positional',
          message: 'Contains control characters',
        },
      ]
    )
    const input = await invoke(cli, ['artifacts', 'put', '--input', '-'], {
      env: KEY,
      stdin: JSON.stringify({ path: 'line\u0007bell' }),
    })
    assert.equal(assertContract(input).ok, true)
  })

  test('reports only the cause when --input cannot be used', async () => {
    const result = await invoke(cli, ['artifacts', 'put', '--input', '-'], {
      env: KEY,
      stdin: '{',
    })
    const error = assertContract(result).error as {
      message: string
      details: unknown[]
    }
    assert.deepEqual(error.details, [
      { path: '--input', source: 'input', message: 'Not valid JSON' },
    ])
    assert.equal(error.message, '--input: Not valid JSON.')
  })

  test('does not double punctuation', async () => {
    const result = await invoke(cli, ['artifacts', 'get', 'x', '--idd', 'y'])
    assert.equal(
      (assertContract(result).error as { message: string }).message,
      '--idd: Unknown flag; did you mean --id?'
    )
  })

  test('an interruption while waiting for --input on stdin ends the command', async () => {
    const controller = new AbortController()
    const never = new PassThrough()
    setTimeout(() => controller.abort('SIGTERM'), 20)
    const result = await invoke(cli, ['artifacts', 'put', '--input', '-'], {
      env: KEY,
      stdin: never,
      signal: controller.signal,
    })
    assert.equal(result.signal, 'SIGTERM')
    assert.equal(
      (result.json?.error as { code: string } | undefined)?.code,
      'interrupted'
    )
  })

  test('agents get group help on stderr after a routing error', async () => {
    const result = await invoke(cli, ['artifacts', 'pt'], {
      env: { AI_AGENT: 'codex' },
    })
    assertContract(result)
    assert.match(result.stderr, /Commands:\n {2}artifacts put/)
  })
})

describe('review fixes', () => {
  test('switches with a value are rejected, so --yes=false never approves', async () => {
    const result = await invoke(cli, ['artifacts', 'put', 'a', '--yes=false'], {
      env: { ...KEY, ACME_NETWORK: 'mainnet' },
    })
    const error = assertContract(result).error as {
      code: string
      details: unknown
    }
    assert.equal(error.code, 'invalid_input')
    assert.deepEqual(error.details, [
      { path: '--yes', source: 'flag', message: '--yes does not take a value' },
    ])
    for (const flag of ['--dry-run=0', '--debug=1', '--json=true']) {
      const other = await invoke(cli, ['artifacts', 'put', 'a', flag], {
        env: KEY,
      })
      assert.equal(
        (assertContract(other).error as { code: string }).code,
        'invalid_input',
        flag
      )
    }
  })

  test('decodes multi-byte characters split across stdin chunks', async () => {
    const bytes = Buffer.from(JSON.stringify({ path: 'café' }))
    const split = bytes.indexOf(0xc3) + 1 // between the two bytes of "é"
    const stdin = Readable.from([
      bytes.subarray(0, split),
      bytes.subarray(split),
    ])
    const result = await invoke(cli, ['artifacts', 'put', '--input', '-'], {
      env: KEY,
      stdin,
    })
    assert.equal(assertContract(result).url, 'https://example.com/café')
  })

  test('schema accepts --format with a separate value', async () => {
    for (const args of [
      ['schema', '--format', 'json'],
      ['schema', '--format', 'json', 'artifacts', 'get'],
      ['--format', 'json', 'schema', 'artifacts', 'get'],
    ]) {
      const result = await invoke(cli, args)
      assert.equal(assertContract(result).ok, true, args.join(' '))
    }
    const human = await invoke(cli, [
      'schema',
      'artifacts',
      'get',
      '--format',
      'human',
    ])
    assert.equal(JSON.parse(human.stdout).command, 'artifacts get')
  })
})

describe('result integrity', () => {
  test('error data cannot override reserved result keys', async () => {
    const result = await invoke(cli, ['broken', 'data'], { strict: false })
    const json = assertContract(result)
    assert.equal(result.exitCode, 1)
    assert.equal(json.ok, false)
    assert.equal((json.error as { code: string }).code, 'timeout')
    assert.equal(json.partial, 'kept')
    assert.equal(json.next, undefined)
    const strict = assertContract(await invoke(cli, ['broken', 'data']))
    assert.equal(
      (strict.error as { message: string }).message,
      'Contract violation: output uses reserved keys: ok, error, next.'
    )
  })

  test('a result that cannot be serialized becomes internal_error', async () => {
    const result = await invoke(cli, ['broken', 'bigint'], { strict: false })
    const json = assertContract(result)
    assert.equal(result.exitCode, 1)
    assert.equal((json.error as { code: string }).code, 'internal_error')
    assert.match(
      (json.error as { message: string }).message,
      /serialize a BigInt/
    )
  })
})
