import type { Context } from 'clipact'
import { globals } from '../globals.ts'
import { type Client, connect } from '../sdk/client.ts'

/** A handler context whose input has the auth fields. */
// biome-ignore lint/suspicious/noExplicitAny: any command with the auth fields
type AuthContext = Context<any, any> & {
  input: { token: string; team: string }
}

/**
 * Creates an API client from a command's auth fields and the CLI's
 * globals. Shared setup is a plain function the handler calls; clipact has
 * no middleware.
 */
export function client(ctx: AuthContext): Promise<Client> {
  const settings = globals.get(ctx)
  return connect({
    token: ctx.input.token,
    team: ctx.input.team,
    signal: ctx.signal,
    home: settings.home,
    latencyMs: settings.mockLatencyMs,
    rateLimit: settings.mockRateLimit,
  })
}
