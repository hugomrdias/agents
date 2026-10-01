import type { Context } from 'clipact'
import type { Client, Deployment } from '../../sdk/client.ts'

/** Converts an SDK deployment to the command output shape. */
export function summarize(deployment: Deployment) {
  return {
    id: deployment.id,
    siteId: deployment.siteId,
    production: deployment.production,
    status: deployment.status,
    url: deployment.url,
    files: deployment.files.length,
    uploaded: deployment.files.filter((file) => file.uploaded).length,
    bytes: deployment.files.reduce((sum, file) => sum + file.size, 0),
    createdAt: deployment.createdAt,
  }
}

/**
 * Uploads the files not yet uploaded, reporting progress. The deployment
 * record was persisted before this starts and each file is recorded as it
 * finishes, so an interruption at any point can be resumed.
 */
export async function uploadRemaining(
  // biome-ignore lint/suspicious/noExplicitAny: shared by commands with different schemas
  ctx: Pick<Context<any, any>, 'progress' | 'checkpoint'>,
  api: Client,
  deployment: Deployment
): Promise<Deployment> {
  ctx.checkpoint({
    id: deployment.id,
    next: [
      {
        by: 'agent',
        command: `launchpad deploys resume ${deployment.id}`,
        description: 'Upload the remaining files of this deployment',
      },
    ],
  })
  const total = deployment.files.length
  let done = deployment.files.filter((file) => file.uploaded).length
  for (const file of deployment.files) {
    if (file.uploaded) {
      continue
    }
    ctx.progress({
      phase: 'upload',
      message: `${done + 1}/${total} ${file.path}`,
      data: { uploaded: done, total },
    })
    await api.uploadFile(deployment.id, file.path)
    done++
  }
  return await api.finalize(deployment.id)
}
