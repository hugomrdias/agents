/**
 * Measures startup of the built CLI against a bare Node.js process.
 * Run `pnpm build` first.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = 'bin/launchpad.js'
const env = {
  PATH: process.env.PATH,
  LAUNCHPAD_TOKEN: 'lp_bench',
  LAUNCHPAD_HOME: mkdtempSync(join(tmpdir(), 'launchpad-bench-')),
}
const cases: [string, string[]][] = [
  ["node -e ''", ['-e', '']],
  ['--version', [bin, '--version']],
  ['--help', [bin, '--help']],
  ['schema sites create', [bin, 'schema', 'sites', 'create']],
  ['sites list', [bin, 'sites', 'list']],
]
const runs = 25
let baseline = 0
for (const [name, args] of cases) {
  spawnSync(process.execPath, args, { env }) // warm the compile cache
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    spawnSync(process.execPath, args, { env })
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(runs / 2)] as number
  baseline ||= median
  const delta =
    median === baseline ? '' : ` (+${(median - baseline).toFixed(1)} ms)`
  process.stdout.write(`${name.padEnd(22)} ${median.toFixed(1)} ms${delta}\n`)
}
