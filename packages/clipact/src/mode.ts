import { detectAgent, isSet, parseBoolean } from './agent.ts'
import type { CliOptions, Mode } from './define.ts'
import type { InputIssue } from './errors.ts'
import type { Io } from './io.ts'
import type { GlobalFlags } from './route.ts'

/**
 * Returns the framework variable prefix: `envPrefix`, or the CLI name,
 * upper-cased with each run of other characters replaced by `_`.
 */
export function resolveEnvPrefix(
  cli: Pick<CliOptions, 'name' | 'envPrefix'>
): string {
  return (cli.envPrefix ?? cli.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/**
 * Names of the framework variables for a prefix, such as `ACME_OUTPUT`.
 * `<PREFIX>_TELEMETRY` is reserved even without a `telemetry` option,
 * because `ctx.telemetry()` reads its opt-out.
 */
export function frameworkVariables(prefix: string): {
  output: string
  agent: string
  telemetry: string
} {
  return {
    output: `${prefix}_OUTPUT`,
    agent: `${prefix}_AGENT`,
    telemetry: `${prefix}_TELEMETRY`,
  }
}

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
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#streams-and-modes
 */
export function resolveMode(
  flags: GlobalFlags,
  io: Io,
  prefix: string
): { mode: Mode; issues: InputIssue[] } {
  const issues: InputIssue[] = []
  const { agent: agentVariable, output: outputVariable } =
    frameworkVariables(prefix)

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
