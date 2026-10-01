import { setTimeout } from 'node:timers/promises'
import { CliError, defineHandler } from '../../src/index.ts'
import { broken } from './commands.ts'

export default defineHandler(broken, async (ctx) => {
  if (ctx.input.kind === 'crash') {
    globalThis.setTimeout(() => {
      throw new Error('async boom')
    }, 10)
    await setTimeout(5000, undefined, { signal: ctx.signal })
  }
  if (ctx.input.kind === 'code') {
    throw new CliError({ code: 'undeclared', message: 'Not in errors.' })
  }
  if (ctx.input.kind === 'retryable') {
    throw new CliError({
      code: 'timeout',
      message: 'Timed out.',
      retryable: true,
    })
  }
  return ctx.ok({ ref: 1 } as unknown as { ref: string })
})
