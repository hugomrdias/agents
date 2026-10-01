import * as z from 'zod'

/**
 * Input fields every API command needs. Spread into each command's input
 * schema; there are no global options in clipact.
 */
export const auth = {
  token: z.string().describe('API token; starts with lp_'),
  team: z.string().default('personal').describe('Team slug'),
}

/** Environment variables for {@link auth}; `token` is also listed in `secrets`. */
export const authEnv = {
  token: 'LAUNCHPAD_TOKEN',
  team: 'LAUNCHPAD_TEAM',
}

/** A site as returned in command output. */
export const site = z.object({
  id: z.string(),
  name: z.string(),
  region: z.enum(['us', 'eu', 'ap']),
  framework: z.string(),
  meta: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
  domains: z.array(
    z.object({ name: z.string(), verified: z.boolean(), txtRecord: z.string() })
  ),
})

/** A deployment as returned in command output. */
export const deployment = z.object({
  id: z.string(),
  siteId: z.string(),
  production: z.boolean(),
  status: z.enum(['uploading', 'ready']),
  url: z.url(),
  files: z.number().int().describe('Number of files'),
  uploaded: z.number().int().describe('Files uploaded so far'),
  bytes: z.number().int(),
  createdAt: z.iso.datetime(),
})
