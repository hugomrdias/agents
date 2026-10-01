import { setTimeout } from 'node:timers/promises'
import { defineHandler } from '../../src/index.ts'
import { wait } from './commands.ts'

export default defineHandler(wait, async (ctx) => {
  ctx.checkpoint({
    id: 'op_1',
    next: [
      {
        by: 'agent',
        command: 'acme operations resume op_1',
        description: 'Resume the operation',
      },
    ],
  })
  await setTimeout(ctx.input.ms, undefined, { signal: ctx.signal })
  return ctx.ok({ done: true })
})
