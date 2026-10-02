/** Environment variables read by the framework. */
export type Env = Record<string, string | undefined>

/** Vendor variables that identify a coding agent, checked after `AI_AGENT` and `AGENT`. */
const VENDOR_VARIABLES: [variable: string, agent: string][] = [
  ['CLAUDECODE', 'claude-code'],
  ['CLAUDE_CODE_CHILD_SESSION', 'claude-code'],
  ['CODEX_THREAD_ID', 'codex'],
  ['CODEX_CI', 'codex'],
  ['GEMINI_CLI', 'gemini-cli'],
  ['CURSOR_AGENT', 'cursor'],
  ['OPENCODE', 'opencode'],
  ['AUGMENT_AGENT', 'augment'],
  ['COPILOT_AGENT_SESSION_ID', 'copilot'],
  ['AMP_CURRENT_THREAD_ID', 'amp'],
  ['QWEN_CODE_SESSION_ID', 'qwen-code'],
]

/** Returns `true` for a set variable that is not an explicit off value. */
function isSet(value: string | undefined): value is string {
  return (
    value !== undefined && value !== '' && value !== '0' && value !== 'false'
  )
}

/**
 * Detects a coding agent from the environment and returns its name.
 *
 * Detection is heuristic and only changes presentation defaults.
 *
 * @see https://github.com/hugomrdias/foc-cli/blob/main/docs/agent-cli-guidelines.md#agent-detection-and-help
 */
export function detectAgent(env: Env): string | false {
  for (const variable of ['AI_AGENT', 'AGENT']) {
    const value = env[variable]
    if (isSet(value)) {
      return value === '1' || value === 'true' ? 'unknown' : value
    }
  }
  for (const [variable, agent] of VENDOR_VARIABLES) {
    if (isSet(env[variable])) {
      return agent
    }
  }
  return false
}
