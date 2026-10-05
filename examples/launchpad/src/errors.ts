import type { ErrorRegistry } from 'clipact'
import * as z from 'zod'
import { site } from './commands/shared.ts'

/**
 * Every error code launchpad commands return besides the built-in codes,
 * published by `launchpad schema <command>`.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli/guidelines.md#errors-next-steps-and-retries
 */
export const errors = {
  auth_required: {
    description: 'The API token is missing or invalid; set LAUNCHPAD_TOKEN.',
  },
  not_found: {
    description: 'No site or deployment has that ID or name.',
  },
  conflict: {
    description: 'Another site already uses that name.',
  },
  file_not_found: {
    description: 'A file or folder to deploy does not exist.',
    details: z.array(z.object({ path: z.string(), message: z.string() })),
  },
  verification_pending: {
    description:
      'The domains are attached but serve traffic only after their DNS TXT records are added.',
    details: z.object({ domains: z.array(site.shape.domains.element) }),
  },
} satisfies ErrorRegistry
