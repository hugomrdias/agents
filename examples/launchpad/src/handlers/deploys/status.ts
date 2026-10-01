import { defineHandler } from 'clipact'
import { status } from '../../commands/deploys.ts'
import { client } from '../client.ts'
import { summarize } from './upload.ts'

export default defineHandler(status, async (ctx) => {
  const api = await client(ctx.input, ctx.signal)
  const deployment = api.getDeployment(ctx.input.deployment)
  return ctx.ok(
    { deployment: summarize(deployment) },
    {
      next:
        deployment.status === 'uploading'
          ? [
              {
                by: 'agent',
                command: `launchpad deploys resume ${deployment.id}`,
                description: 'Finish uploading',
              },
            ]
          : undefined,
    }
  )
})
