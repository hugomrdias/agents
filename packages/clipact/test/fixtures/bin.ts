import { cli } from './cli.ts'

// run() installs its signal handlers before its first await, so process
// tests can wait for this line instead of guessing how long startup takes.
const running = cli.run()
if (process.env.ACME_TEST_READY) {
  process.stderr.write('acme: signal handlers ready\n')
}
await running
