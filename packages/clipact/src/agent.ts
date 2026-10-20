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
export function isSet(value: string | undefined): value is string {
  return (
    value !== undefined && value !== '' && value !== '0' && value !== 'false'
  )
}

/**
 * Detects a coding agent from the environment and returns its name.
 *
 * Detection is heuristic and only changes presentation defaults.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#agent-detection-and-help
 */
export function detectAgent(env: Env): string | false {
  return identifyAgent(env)?.agent ?? false
}

/** A detected agent, with its version when the variable carries one. */
export interface DetectedAgent {
  agent: string
  version?: string
}

/**
 * Detects a coding agent like {@link detectAgent}, and splits an `AI_AGENT`
 * or `AGENT` value of the form `<name>_<version>_agent`, such as Claude
 * Code's `claude-code_2-1-299_agent`, into the name and the version. The
 * version starts with a digit, so `my_custom_agent` stays one name.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#agent-detection-and-help
 */
export function identifyAgent(env: Env): DetectedAgent | undefined {
  for (const variable of ['AI_AGENT', 'AGENT']) {
    const value = env[variable]
    if (isSet(value)) {
      if (value === '1' || value === 'true') {
        return { agent: 'unknown' }
      }
      const match = /^(.+?)_(\d[^_]*)_agent$/.exec(value)
      return match
        ? { agent: match[1] as string, version: match[2] as string }
        : { agent: value }
    }
  }
  for (const [variable, agent] of VENDOR_VARIABLES) {
    if (isSet(env[variable])) {
      return { agent }
    }
  }
  return undefined
}

/** Parses common boolean spellings: `true`, `false`, `1`, and `0`. */
export function parseBoolean(raw: string): boolean | undefined {
  if (raw === 'true' || raw === '1') {
    return true
  }
  if (raw === 'false' || raw === '0') {
    return false
  }
  return undefined
}
