import { defineGlobals } from 'clipact'
import * as z from 'zod'

/**
 * Mock backend settings, read only from the environment by every command.
 * Handlers read them with `globals.get(ctx)` and pass them to the SDK.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/packages/clipact/README.md#globals
 */
export const globals = defineGlobals({
  input: z.object({
    home: z
      .string()
      .optional()
      .describe('State directory; defaults to <tmpdir>/launchpad-example'),
    mockLatencyMs: z
      .number()
      .int()
      .min(0)
      .default(150)
      .describe('Mock delay per uploaded file, in milliseconds'),
    mockRateLimit: z
      .boolean()
      .default(false)
      .describe('Rate limit every sites list call'),
  }),
  env: {
    home: 'LAUNCHPAD_HOME',
    mockLatencyMs: 'LAUNCHPAD_MOCK_LATENCY_MS',
    mockRateLimit: 'LAUNCHPAD_MOCK_RATE_LIMIT',
  },
})
