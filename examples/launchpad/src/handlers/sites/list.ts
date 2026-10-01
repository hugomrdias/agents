import { defineHandler } from 'clipact'
import { list } from '../../commands/sites.ts'
import { client } from '../client.ts'

export default defineHandler(list, async (ctx) => {
  const api = await client(ctx.input, ctx.signal)
  const { sites, nextCursor } = api.listSites(ctx.input)
  return ctx.ok(
    {
      sites: sites.map(({ id, name, region, framework }) => ({
        id,
        name,
        region,
        framework,
      })),
      nextCursor,
    },
    {
      next: nextCursor
        ? [
            {
              by: 'agent',
              command: `launchpad sites list --limit ${ctx.input.limit} --cursor ${nextCursor}`,
              description: 'Fetch the next page',
            },
          ]
        : undefined,
    }
  )
})
