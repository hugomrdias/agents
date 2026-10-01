import { defineHandler } from 'clipact'
import { resume } from '../../commands/deploys.ts'
import { client } from '../client.ts'
import { summarize, uploadRemaining } from './upload.ts'

export default defineHandler(resume, async (ctx) => {
  const api = await client(ctx.input, ctx.signal)
  const existing = api.getDeployment(ctx.input.deployment)
  const deployment =
    existing.status === 'ready'
      ? existing
      : await uploadRemaining(ctx, api, existing)
  return ctx.ok({ deployment: summarize(deployment) })
})
