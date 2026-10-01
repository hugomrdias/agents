import { CliError, defineHandler } from '../../src/index.ts'
import { get } from './commands.ts'
import { SdkNotFoundError } from './sdk.ts'

export default defineHandler(get, (ctx) => {
  const { id } = ctx.input
  if (id === 'busy') {
    throw new CliError({
      code: 'rate_limited',
      message: 'Slow down.',
      retryAfterSeconds: 3,
    })
  }
  if (id === 'missing') {
    throw new SdkNotFoundError(id)
  }
  if (id === 'boom') {
    throw new Error('socket hang up')
  }
  return ctx.ok({ id, size: 42 })
})
