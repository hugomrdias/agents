import { defineHandler } from 'clipact'
import { get } from '../../commands/sites.ts'
import { client } from '../client.ts'

export default defineHandler(get, async (ctx) => {
  const api = await client(ctx)
  return ctx.ok({ site: api.getSite(ctx.input.site) })
})
