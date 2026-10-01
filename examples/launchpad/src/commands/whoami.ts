import { defineCommand } from 'clipact'
import * as z from 'zod'
import { auth, authEnv } from './shared.ts'

/** Shows the team and how the CLI sees its caller. */
export const whoami = defineCommand({
  name: 'whoami',
  description: 'Show the current team and output mode',
  input: z.strictObject({ ...auth }),
  env: authEnv,
  secrets: ['token'],
  output: z.object({
    team: z.string(),
    agent: z.union([z.string(), z.literal(false)]),
    format: z.enum(['json', 'human']),
    interactive: z.boolean(),
  }),
  errors: ['auth_required'],
  readOnly: true,
  handler: () => import('../handlers/whoami.ts'),
})
