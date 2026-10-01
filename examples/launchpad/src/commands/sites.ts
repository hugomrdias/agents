import { defineCommand, defineGroup } from 'clipact'
import * as z from 'zod'
import { auth, authEnv, site } from './shared.ts'

/** Lists sites with cursor pagination. */
export const list = defineCommand({
  name: 'list',
  description: 'List sites',
  examples: [
    'launchpad sites list',
    'launchpad sites list --limit 5 --cursor 5',
  ],
  input: z.strictObject({
    ...auth,
    limit: z.number().int().min(1).max(100).default(20).describe('Page size'),
    cursor: z.string().optional().describe('Cursor from a previous page'),
  }),
  env: authEnv,
  secrets: ['token'],
  output: z.object({
    sites: z.array(
      site.pick({ id: true, name: true, region: true, framework: true })
    ),
    nextCursor: z.string().optional(),
  }),
  errors: ['auth_required'],
  readOnly: true,
  human: ({ sites, nextCursor }) =>
    sites.length === 0
      ? 'No sites yet. Create one with: launchpad sites create <name>'
      : [
          ...sites.map(
            (s) =>
              `${s.id.padEnd(10)} ${s.name.padEnd(24)} ${s.region}  ${s.framework}`
          ),
          ...(nextCursor
            ? [`More: launchpad sites list --cursor ${nextCursor}`]
            : []),
        ].join('\n'),
  handler: () => import('../handlers/sites/list.ts'),
})

/** Shows one site. */
export const get = defineCommand({
  name: 'get',
  description: 'Show a site by ID or name',
  examples: ['launchpad sites get my-blog'],
  input: z.strictObject({
    ...auth,
    site: z.string().describe('Site ID or name'),
  }),
  positionals: ['site'],
  env: authEnv,
  secrets: ['token'],
  output: z.object({ site }),
  errors: ['auth_required', 'not_found'],
  readOnly: true,
  handler: () => import('../handlers/sites/get.ts'),
})

/** Creates a site; complex requests can come from `--input`. */
export const create = defineCommand({
  name: 'create',
  description: 'Create a site',
  examples: [
    'launchpad sites create my-blog --region eu --framework astro',
    'echo \'{"name":"docs","meta":{"owner":"web"}}\' | launchpad sites create --input -',
  ],
  input: z.strictObject({
    ...auth,
    name: z
      .string()
      .regex(
        /^[a-z0-9-]{3,40}$/,
        'Use 3–40 lowercase letters, digits, or hyphens'
      )
      .describe('Unique site name'),
    region: z.enum(['us', 'eu', 'ap']).default('us').describe('Hosting region'),
    framework: z
      .enum(['static', 'vite', 'next', 'astro'])
      .default('static')
      .describe('Build preset'),
    meta: z
      .record(z.string(), z.string())
      .default({})
      .describe('Free-form labels as a JSON object'),
  }),
  positionals: ['name'],
  env: { ...authEnv, region: 'LAUNCHPAD_REGION' },
  secrets: ['token'],
  output: z.object({ site }),
  errors: ['auth_required', 'conflict'],
  human: ({ site: s }) => `Created ${s.name} (${s.id}) in ${s.region}.`,
  handler: () => import('../handlers/sites/create.ts'),
})

/** Deletes a site; always asks for confirmation. */
export const remove = defineCommand({
  name: 'delete',
  description: 'Delete a site and all its deployments',
  examples: [
    'launchpad sites delete my-blog --dry-run',
    'launchpad sites delete my-blog --yes',
  ],
  input: z.strictObject({
    ...auth,
    site: z.string().describe('Site ID or name'),
  }),
  positionals: ['site'],
  env: authEnv,
  secrets: ['token'],
  output: z.object({
    site: site.pick({ id: true, name: true }),
    deleted: z.boolean(),
  }),
  errors: ['auth_required', 'not_found'],
  confirm: 'Deletes the site, its domains, and all deployments permanently.',
  dryRun: true,
  human: ({ site: s, deleted }) =>
    deleted ? `Deleted ${s.name}.` : `Would delete ${s.name} (${s.id}).`,
  handler: () => import('../handlers/sites/delete.ts'),
})

/** Attaches custom domains; safe to repeat, which also rechecks verification. */
export const addDomains = defineCommand({
  name: 'add',
  description: 'Attach custom domains to a site',
  examples: [
    'launchpad sites domains add my-blog blog.example www.blog.example',
  ],
  input: z.strictObject({
    ...auth,
    site: z.string().describe('Site ID or name'),
    domains: z
      .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]+$/, 'Not a domain name'))
      .min(1),
  }),
  positionals: ['site', 'domains'],
  env: authEnv,
  secrets: ['token'],
  output: z.object({ domains: z.array(site.shape.domains.element) }),
  errors: ['auth_required', 'not_found', 'verification_pending'],
  idempotent: true,
  human: ({ domains }) => domains.map((d) => `${d.name}: verified`).join('\n'),
  handler: () => import('../handlers/sites/domains-add.ts'),
})

export const sites = defineGroup({
  name: 'sites',
  description: 'Create and manage sites',
  commands: [
    list,
    get,
    create,
    remove,
    defineGroup({
      name: 'domains',
      description: 'Custom domains',
      commands: [addDomains],
    }),
  ],
})
