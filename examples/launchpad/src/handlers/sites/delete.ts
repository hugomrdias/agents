import { defineHandler } from 'clipact'
import { remove } from '../../commands/sites.ts'
import { client } from '../client.ts'

export default defineHandler(remove, async (ctx) => {
  const api = await client(ctx.input, ctx.signal)
  if (ctx.dryRun) {
    const { id, name } = api.getSite(ctx.input.site)
    return ctx.ok({ site: { id, name }, deleted: false })
  }
  const { id, name } = await api.deleteSite(ctx.input.site)
  return ctx.ok({ site: { id, name }, deleted: true })
})
