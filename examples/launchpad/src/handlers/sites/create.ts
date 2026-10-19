import { defineHandler } from 'clipact'
import { create } from '../../commands/sites.ts'
import { client } from '../client.ts'

export default defineHandler(create, async (ctx) => {
  const api = await client(ctx)
  const { name, region, framework, meta } = ctx.input
  const site = await api.createSite({ name, region, framework, meta })
  return ctx.ok(
    { site },
    {
      next: [
        {
          by: 'agent',
          command: `launchpad deploys create ${site.name} ./dist`,
          description: 'Deploy files to the new site',
        },
      ],
    }
  )
})
