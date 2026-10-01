import { CliError } from 'clipact'
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
} from './sdk/client.ts'

/**
 * Translates SDK errors into stable CLI error codes. Loaded only when a
 * handler throws something other than a CliError.
 */
export default function mapError(error: unknown): CliError | undefined {
  if (error instanceof UnauthorizedError) {
    return new CliError({
      code: 'auth_required',
      message: error.message,
      next: [
        {
          by: 'user',
          description:
            'Create a token at https://launchpad.example/tokens and set LAUNCHPAD_TOKEN',
        },
      ],
    })
  }
  if (error instanceof NotFoundError) {
    return new CliError({
      code: 'not_found',
      message: error.message,
      next: [
        {
          by: 'agent',
          command: 'launchpad sites list',
          description: 'List the sites you can access',
        },
      ],
    })
  }
  if (error instanceof ConflictError) {
    return new CliError({ code: 'conflict', message: error.message })
  }
  if (error instanceof RateLimitError) {
    // retryable is left unset: clipact makes it true for read-only and
    // idempotent commands and false otherwise.
    return new CliError({
      code: 'rate_limited',
      message: error.message,
      retryAfterSeconds: error.retryAfter,
    })
  }
  return undefined
}
