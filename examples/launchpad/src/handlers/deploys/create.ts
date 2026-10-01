import { defineHandler } from 'clipact'
import { create } from '../../commands/deploys.ts'
import { client } from '../client.ts'
import { collectFiles } from './files.ts'
import { summarize, uploadRemaining } from './upload.ts'

export default defineHandler(create, async (ctx) => {
  const { site: siteName, paths, prod } = ctx.input
  const files = await collectFiles(paths)
  const api = await client(ctx.input, ctx.signal)
  const site = api.getSite(siteName)

  if (ctx.dryRun) {
    // Same result shape, no side effects.
    return ctx.ok({
      dryRun: true,
      deployment: {
        id: 'dpl_dry_run',
        siteId: site.id,
        production: prod,
        status: 'uploading',
        url: prod
          ? `https://${site.name}.launchpad.example`
          : `https://preview--${site.name}.launchpad.example`,
        files: files.length,
        uploaded: 0,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        createdAt: new Date().toISOString(),
      },
    })
  }

  ctx.log(
    `Deploying ${files.length} files to ${site.name}${prod ? ' (production)' : ''}`
  )
  const record = await api.createDeployment(site.id, {
    production: prod,
    files,
  })
  const deployment = await uploadRemaining(ctx, api, record)
  return ctx.ok(
    { dryRun: false, deployment: summarize(deployment) },
    {
      next: [
        {
          by: 'agent',
          command: `launchpad deploys status ${deployment.id}`,
          description: 'Inspect the deployment',
        },
      ],
    }
  )
})
