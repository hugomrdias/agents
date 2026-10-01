import { defineCommand, defineGroup } from 'clipact'
import * as z from 'zod'
import { auth, authEnv, deployment } from './shared.ts'

/** Uploads files as a new deployment; production deploys need confirmation. */
export const create = defineCommand({
  name: 'create',
  description: 'Deploy files or folders to a site',
  examples: [
    'launchpad deploys create my-blog ./dist',
    'launchpad deploys create my-blog ./dist --prod --yes',
    'launchpad deploy my-blog index.html about.html --dry-run',
  ],
  input: z.strictObject({
    ...auth,
    site: z.string().describe('Site ID or name'),
    paths: z.array(z.string()).min(1).describe('Files or folders to upload'),
    prod: z.boolean().default(false).describe('Publish to the production URL'),
    message: z.string().max(200).optional().describe('Deployment note'),
  }),
  positionals: ['site', 'paths'],
  env: authEnv,
  secrets: ['token'],
  output: z.object({ deployment, dryRun: z.boolean() }),
  errors: ['auth_required', 'not_found', 'file_not_found'],
  confirm: (input) =>
    input.prod
      ? `Replaces the live production site "${input.site}".`
      : undefined,
  dryRun: true,
  human: ({ deployment: d, dryRun }) =>
    dryRun
      ? `Would upload ${d.files} files (${d.bytes} bytes).`
      : `Deployed ${d.files} files to ${d.url}`,
  handler: () => import('../handlers/deploys/create.ts'),
})

/** Shows a deployment. */
export const status = defineCommand({
  name: 'status',
  description: 'Show a deployment',
  input: z.strictObject({
    ...auth,
    deployment: z.string().describe('Deployment ID'),
  }),
  positionals: ['deployment'],
  env: authEnv,
  secrets: ['token'],
  output: z.object({ deployment }),
  errors: ['auth_required', 'not_found'],
  readOnly: true,
  human: ({ deployment: d }) =>
    `${d.id} ${d.status} ${d.uploaded}/${d.files} files ${d.url}`,
  handler: () => import('../handlers/deploys/status.ts'),
})

/** Uploads the remaining files of an interrupted deployment. */
export const resume = defineCommand({
  name: 'resume',
  description: 'Finish an interrupted deployment',
  input: z.strictObject({
    ...auth,
    deployment: z.string().describe('Deployment ID'),
  }),
  positionals: ['deployment'],
  env: authEnv,
  secrets: ['token'],
  output: z.object({ deployment }),
  errors: ['auth_required', 'not_found', 'file_not_found'],
  idempotent: true,
  human: ({ deployment: d }) => `Deployed ${d.files} files to ${d.url}`,
  handler: () => import('../handlers/deploys/resume.ts'),
})

export const deploys = defineGroup({
  name: 'deploys',
  description: 'Upload and inspect deployments',
  commands: [create, status, resume],
})
