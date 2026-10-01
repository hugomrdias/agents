import { CliError, defineHandler } from '../../src/index.ts'
import { put } from './commands.ts'

export default defineHandler(put, (ctx) => {
  const { path, copies, tags } = ctx.input
  if (path === 'broke') {
    throw new CliError({
      code: 'insufficient_funds',
      message: 'The payer cannot cover the lockup.',
      next: [
        { by: 'user', command: 'acme auth fund', description: 'Add funds' },
      ],
    })
  }
  if (path === 'slow') {
    throw new CliError({ code: 'timeout', message: 'Upload timed out.' })
  }
  if (ctx.dryRun) {
    return ctx.ok({ ref: 'dry-run', url: 'https://example.com/dry-run' })
  }
  ctx.progress({ phase: 'upload', message: `Uploading ${path}` })
  return ctx.ok(
    { ref: `ref-${copies}`, url: `https://example.com/${path}`, tags },
    {
      next: [
        {
          by: 'agent',
          command: `acme artifacts get ref-${copies}`,
          description: 'Inspect it',
        },
      ],
    }
  )
})
