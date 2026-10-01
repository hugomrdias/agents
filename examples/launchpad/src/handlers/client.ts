import { type Client, connect } from '../sdk/client.ts'

/**
 * Creates an API client from a command's auth fields. Shared setup is a
 * plain function the handler calls; clipact has no middleware.
 */
export function client(
  input: { token: string; team: string },
  signal: AbortSignal
): Promise<Client> {
  return connect({ token: input.token, team: input.team, signal })
}
