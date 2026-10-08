/**
 * Types of the `virtual:agent-skills` module. Add
 * `/// <reference types="vite-plugin-agent-skills/client" />` to a
 * declaration file, or list `vite-plugin-agent-skills/client` in `types`.
 */
declare module 'virtual:agent-skills' {
  import type { DiscoveryIndex, SkillSummary } from 'vite-plugin-agent-skills'

  /** The discovery index served at `.well-known/agent-skills/index.json`. */
  export const index: DiscoveryIndex
  /** Each published skill, with its site path. */
  export const skills: readonly SkillSummary[]
}
