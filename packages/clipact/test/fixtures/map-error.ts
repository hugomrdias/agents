import { CliError } from '../../src/index.ts'
import { SdkNotFoundError } from './sdk.ts'

/** Translates SDK errors into stable codes. */
export default function mapError(error: unknown): CliError | undefined {
  if (error instanceof SdkNotFoundError) {
    return new CliError({ code: 'not_found', message: error.message })
  }
  return undefined
}
