import { appendFile } from 'node:fs/promises'
import type { TelemetrySender } from '../../src/index.ts'

/** Appends each event to the file named by `ACME_TEST_TELEMETRY_OUT`. */
const send: TelemetrySender = async (event) => {
  const out = process.env.ACME_TEST_TELEMETRY_OUT
  if (!out) {
    throw new Error('ACME_TEST_TELEMETRY_OUT is not set')
  }
  await appendFile(out, `${JSON.stringify(event)}\n`)
}

export default send
