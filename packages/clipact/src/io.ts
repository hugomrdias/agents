import { styleText } from 'node:util'
import type { Env } from './agent.ts'

/** A writable stream such as `process.stdout`. */
export interface OutputStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean
  isTTY?: boolean
}

/** The process streams and environment a CLI runs with; replaced in tests. */
export interface Io {
  env: Env
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: OutputStream
  stderr: OutputStream
}

/** Returns the real process streams and environment. */
export function processIo(): Io {
  return {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

/** Writes a chunk and resolves when it has been handed to the OS. */
export function writeAsync(stream: OutputStream, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(chunk, () => resolve())
  })
}

/** Text styles used by human output. */
export type Style = Parameters<typeof styleText>[0]

/**
 * Returns a styling function that colors only when allowed: never for
 * agents, and otherwise as `util.styleText` decides from the stream,
 * `NO_COLOR`, `FORCE_COLOR`, and `TERM`.
 */
export function styler(
  stream: OutputStream,
  enabled: boolean
): (style: Style, text: string) => string {
  if (!enabled || !stream.isTTY) {
    return (_style, text) => text
  }
  return (style, text) =>
    styleText(style, text, { stream: stream as NodeJS.WritableStream })
}
