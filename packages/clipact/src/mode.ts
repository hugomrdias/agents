import { detectAgent, isSet, parseBoolean } from './agent.ts'
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
 * @see https://github.com/hugomrdias/fil/blob/main/docs/agent-cli/guidelines.md#streams-and-modes
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
    override = parseBoolean(rawAgent)
    if (override === undefined) {
      issues.push({
        path: agentVariable,
        source: `env:${agentVariable}`,
        message: 'Expected 1, 0, true, or false',
      })
    }
  }
  const detected = detectAgent(io.env)
  const agent =
    override === undefined ? detected : override && (detected || 'unknown')

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

  const interactive =
    Boolean(io.stdin.isTTY && io.stdout.isTTY) && !agent && !isSet(io.env.CI)
  return { mode: { format, agent, interactive }, issues }
}
