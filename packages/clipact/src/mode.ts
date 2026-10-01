import { detectAgent } from './agent.ts'
import type { Mode } from './define.ts'
import type { InputIssue } from './errors.ts'
import type { Io } from './io.ts'
import type { GlobalFlags } from './route.ts'

/** Returns `true` for a supported output format. */
function isFormat(value: string | undefined): value is Mode['format'] {
  return value === 'json' || value === 'human'
}

/**
 * Resolves the output format, agent, and interactivity. Explicit flags win
 * over framework variables, which win over agent detection and TTYs.
 * Invalid values are returned as issues and otherwise ignored, so
 * discovery commands still work.
 *
 * @see https://github.com/filoz/foc-cli/blob/main/docs/agent-cli-guidelines.md#streams-and-modes
 */
export function resolveMode(
  flags: GlobalFlags,
  io: Io,
  prefix: string
): { mode: Mode; issues: InputIssue[] } {
  const issues: InputIssue[] = []
  const agentVariable = `${prefix}_AGENT`
  const outputVariable = `${prefix}_OUTPUT`

  let override = flags.agent
  const rawAgent = io.env[agentVariable]
  if (override === undefined && rawAgent) {
    if (rawAgent === '1' || rawAgent === 'true') {
      override = true
    } else if (rawAgent === '0' || rawAgent === 'false') {
      override = false
    } else {
      issues.push({
        path: agentVariable,
        source: `env:${agentVariable}`,
        message: 'Expected 1, 0, true, or false',
      })
    }
  }
  const detected = detectAgent(io.env)
  let agent: string | false = detected
  if (override === false) {
    agent = false
  } else if (override === true) {
    agent = detected || 'unknown'
  }

  if (flags.format !== undefined && !isFormat(flags.format)) {
    issues.push({
      path: '--format',
      source: 'flag',
      message: 'Expected json or human',
    })
  }
  if (flags.json && flags.format === 'human') {
    issues.push({
      path: '--json',
      source: 'flag',
      message: 'Conflicts with --format human',
    })
  }
  const rawOutput = io.env[outputVariable]
  if (rawOutput && !isFormat(rawOutput)) {
    issues.push({
      path: outputVariable,
      source: `env:${outputVariable}`,
      message: 'Expected json or human',
    })
  }

  let format: Mode['format']
  if (flags.json) {
    format = 'json'
  } else if (isFormat(flags.format)) {
    format = flags.format
  } else if (isFormat(rawOutput)) {
    format = rawOutput
  } else if (agent || !io.stdout.isTTY) {
    format = 'json'
  } else {
    format = 'human'
  }

  const ci = io.env.CI
  const interactive =
    Boolean(io.stdin.isTTY && io.stdout.isTTY) &&
    !agent &&
    !(ci && ci !== '0' && ci !== 'false')
  return { mode: { format, agent, interactive }, issues }
}
