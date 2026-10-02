import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import type { Env } from './agent.ts'
import type { Cli, Outcome } from './cli.ts'
import { commandSchema } from './discovery.ts'
import { leaves } from './help.ts'
import type { OutputStream } from './io.ts'
import { resolveSpec } from './spec.ts'

/** Captured output of one invocation. */
export interface RunResult {
  /** `null` when the process ended by a signal. */
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** stdout parsed as JSON when it is one JSON value. */
  json: Record<string, unknown> | undefined
}

/** Options for {@link invoke}. */
export interface InvokeOptions {
  /** Environment; empty by default so the test runner's agent variables do not leak in. */
  env?: Env
  /** Text to read from stdin, or a stream, such as one that never ends. */
  stdin?: string | NodeJS.ReadableStream
  /** Pretend stdin, stdout, and stderr are terminals. */
  tty?: boolean
  signal?: AbortSignal
  /** Validate outputs and error codes against the definitions; on by default. */
  strict?: boolean
}

/** A stream that collects writes into a string. */
class Capture implements OutputStream {
  text = ''
  isTTY: boolean

  /** Creates a capture with the given TTY flag. */
  constructor(isTTY: boolean) {
    this.isTTY = isTTY
  }

  /** Appends a chunk. */
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.text += chunk
    callback?.()
    return true
  }
}

/** Parses stdout as one JSON value, or returns `undefined`. */
function parseJson(stdout: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

/**
 * Runs a CLI in process with captured streams and strict contract checks.
 */
export async function invoke(
  cli: Cli,
  args: string[],
  options: InvokeOptions = {}
): Promise<RunResult & { outcome: Outcome }> {
  const tty = options.tty === true
  const stdout = new Capture(tty)
  const stderr = new Capture(tty)
  const stdin = Object.assign(
    typeof options.stdin === 'object'
      ? options.stdin
      : Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    { isTTY: tty }
  )
  const outcome = await cli.execute(
    args,
    { env: options.env ?? {}, stdin, stdout, stderr },
    { signal: options.signal, strict: options.strict ?? true }
  )
  return {
    exitCode: outcome.signal ? null : outcome.exitCode,
    signal: outcome.signal ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    json: parseJson(stdout.text),
    outcome,
  }
}

/** Options for {@link exec}. */
export interface ExecOptions {
  /** Added to a minimal environment containing only `PATH`. */
  env?: Env
  stdin?: string
  /** Sends this signal once stderr contains `when`, or after `afterMs`. */
  kill?: { signal: NodeJS.Signals; when?: string; afterMs?: number }
  /** Leave stdin open instead of closing it after `stdin` is written. */
  keepStdinOpen?: boolean
  timeoutMs?: number
}

/**
 * Spawns a CLI entry file with Node, without a TTY, and captures its output.
 */
export function exec(
  bin: string,
  args: string[],
  options: ExecOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { PATH: process.env.PATH, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 10_000,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    if (options.kill?.afterMs !== undefined) {
      const { signal, afterMs } = options.kill
      setTimeout(() => {
        killed = true
        child.kill(signal)
      }, afterMs)
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      const when = options.kill?.when
      if (options.kill && !killed && when && stderr.includes(when)) {
        killed = true
        child.kill(options.kill.signal)
      }
    })
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr, json: parseJson(stdout) })
    })
    if (options.keepStdinOpen) {
      child.stdin.write(options.stdin ?? '')
      child.on('close', () => child.stdin.destroy())
    } else {
      child.stdin.end(options.stdin ?? '')
    }
  })
}

/**
 * Asserts the output contract: stdout is exactly one compact JSON object
 * with a boolean `ok`, the exit code matches `ok`, stdout has no ANSI codes,
 * and stderr has no JSON results. Returns the parsed result.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#output-contract
 */
export function assertContract(result: RunResult): Record<string, unknown> {
  const lines = result.stdout.split('\n')
  assert.equal(lines.length, 2, `stdout must be one line:\n${result.stdout}`)
  assert.equal(lines[1], '', 'stdout must end with one newline')
  assert.ok(
    !result.stdout.includes('\u001b['),
    'stdout must not contain ANSI codes'
  )
  const json = result.json
  assert.ok(
    json && typeof json === 'object' && !Array.isArray(json),
    'stdout must be a JSON object'
  )
  assert.equal(typeof json.ok, 'boolean', '"ok" must be a boolean')
  if (result.signal === null) {
    assert.equal(
      result.exitCode,
      json.ok ? 0 : 1,
      'exit code must be 0 if ok, else 1'
    )
  }
  for (const line of result.stderr.split('\n')) {
    if (line.startsWith('{')) {
      assert.equal(
        parseJson(line),
        undefined,
        'stderr must not contain JSON results'
      )
    }
  }
  return json
}

/** Resolves every command definition and throws one error listing all problems. */
export function assertDefinitions(cli: Cli): void {
  const root = {
    kind: 'group' as const,
    name: cli.options.name,
    description: '',
    commands: cli.options.commands,
  }
  const problems: string[] = []
  for (const { path, command } of leaves(root)) {
    try {
      resolveSpec(command, path)
    } catch (error) {
      problems.push((error as Error).message)
    }
  }
  assert.deepEqual(problems, [], 'command definitions must be valid')
}

/** Returns every command's `schema` output keyed by path, for snapshot tests. */
export function schemas(cli: Cli): Record<string, Record<string, unknown>> {
  const root = {
    kind: 'group' as const,
    name: cli.options.name,
    description: '',
    commands: cli.options.commands,
  }
  return Object.fromEntries(
    leaves(root).map(({ path, command }) => [
      path,
      commandSchema(cli.options, resolveSpec(command, path)),
    ])
  )
}
