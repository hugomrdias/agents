import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertContract, exec } from '../src/testing.ts'

const BIN = fileURLToPath(new URL('./fixtures/bin.ts', import.meta.url))

describe('process', () => {
  test('writes one result and exits 0 or 1', async () => {
    const ok = await exec(BIN, ['artifacts', 'get', 'x'])
    assert.equal(assertContract(ok).ok, true)
    assert.equal(ok.exitCode, 0)
    const failed = await exec(BIN, ['artifacts', 'get', 'missing'])
    assert.equal(assertContract(failed).ok, false)
    assert.equal(failed.exitCode, 1)
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`writes an interrupted result and re-raises ${signal}`, async () => {
      const result = await exec(BIN, ['operations', 'wait'], {
        kill: { signal, when: 'started op_1' },
      })
      assert.equal(result.signal, signal)
      assert.equal(result.exitCode, null)
      const json = assertContract(result)
      assert.deepEqual(json.error, {
        code: 'interrupted',
        message: `Interrupted by ${signal}.`,
        retryable: false,
      })
      assert.equal(
        (json.next as { command: string }[])[0]?.command,
        'acme operations resume op_1'
      )
    })
  }

  test('converts an uncaught exception into internal_error', async () => {
    const result = await exec(BIN, ['broken', 'crash'])
    const json = assertContract(result)
    assert.deepEqual(json.error, {
      code: 'internal_error',
      message: 'Unexpected error: async boom',
      retryable: false,
    })
    assert.equal(result.exitCode, 1)
  })

  test('detects agents from the environment', async () => {
    const result = await exec(BIN, ['artifacts', 'get'], {
      env: { CLAUDECODE: '1' },
    })
    assertContract(result)
    assert.match(result.stderr, /Full schema: acme schema artifacts get/)
  })
})

describe('process stdin', () => {
  test('SIGTERM while waiting for --input on an open stdin ends the process', async () => {
    const result = await exec(BIN, ['artifacts', 'put', '--input', '-'], {
      env: { ACME_PRIVATE_KEY: 'k' },
      keepStdinOpen: true,
      kill: { signal: 'SIGTERM', afterMs: 300 },
      timeoutMs: 5000,
    })
    assert.equal(result.signal, 'SIGTERM')
    assert.equal(
      (assertContract(result).error as { code: string }).code,
      'interrupted'
    )
  })
})
