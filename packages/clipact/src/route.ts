import type { CommandNode, Group } from './define.ts'
import { DefinitionError } from './errors.ts'

/** Framework flags that take a value, as raw tokens. */
const VALUE_FLAGS = ['--format', '--input']

/** Framework flags without a value, as raw tokens. */
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--agent',
  '--no-agent',
  '--debug',
  '--help',
  '-h',
  '--version',
  '--yes',
  '--dry-run',
])

/** Framework flags that decide the mode and fast paths, scanned before parsing. */
export interface GlobalFlags {
  json: boolean
  format: string | undefined
  agent: boolean | undefined
  debug: boolean
  help: boolean
  version: boolean
}

/** A positional word before any non-framework option. */
interface Word {
  index: number
  value: string
}

/** The result of routing argv through the command tree. */
export type Route =
  | { kind: 'node'; node: CommandNode; path: string[]; consumed: number[] }
  | { kind: 'schema'; consumed: number[] }
  | {
      kind: 'unknown'
      group: Group
      path: string[]
      word: string
      suggestion: string | undefined
    }

/** Collects framework flags from anywhere before `--`. */
export function scanGlobalFlags(args: string[]): GlobalFlags {
  const flags: GlobalFlags = {
    json: false,
    format: undefined,
    agent: undefined,
    debug: false,
    help: false,
    version: false,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '--') {
      break
    }
    if (arg === '--json') {
      flags.json = true
    } else if (arg === '--agent') {
      flags.agent = true
    } else if (arg === '--no-agent') {
      flags.agent = false
    } else if (arg === '--debug') {
      flags.debug = true
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg === '--version') {
      flags.version = true
    } else if (arg === '--format') {
      flags.format = args[index + 1] ?? ''
      index++
    } else if (arg.startsWith('--format=')) {
      flags.format = arg.slice('--format='.length)
    }
  }
  return flags
}

/** Returns the leading positional words, skipping framework flags. */
function leadingWords(args: string[]): Word[] {
  const words: Word[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '--') {
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (VALUE_FLAGS.includes(arg)) {
        index++
        continue
      }
      if (
        BOOLEAN_FLAGS.has(arg) ||
        VALUE_FLAGS.some((flag) => arg.startsWith(`${flag}=`))
      ) {
        continue
      }
      break
    }
    words.push({ index, value: arg })
  }
  return words
}

/** Finds a node by its canonical path below `root`. */
export function findNode(root: Group, path: string[]): CommandNode | undefined {
  let node: CommandNode = root
  for (const name of path) {
    if (node.kind !== 'group') {
      return undefined
    }
    const child: CommandNode | undefined = node.commands.find(
      (candidate) => candidate.name === name
    )
    if (!child) {
      return undefined
    }
    node = child
  }
  return node
}

/**
 * Routes leading positional words through groups until a command is
 * reached, resolving aliases and the built-in `schema` command at the root.
 */
export function route(
  root: Group,
  args: string[],
  aliases: Record<string, string> = {}
): Route {
  const words = leadingWords(args)
  let node: CommandNode = root
  const path: string[] = []
  const consumed: number[] = []
  let position = 0

  const sortedAliases = Object.entries(aliases).sort(
    ([a], [b]) => b.split(' ').length - a.split(' ').length
  )
  for (const [alias, target] of sortedAliases) {
    const aliasWords = alias.split(' ')
    if (aliasWords.every((word, index) => words[index]?.value === word)) {
      const targetPath = target.split(' ')
      const resolved = findNode(root, targetPath)
      if (!resolved) {
        throw new DefinitionError(alias, `alias target "${target}" not found`)
      }
      node = resolved
      path.push(...targetPath)
      consumed.push(...words.slice(0, aliasWords.length).map((w) => w.index))
      position = aliasWords.length
      break
    }
  }

  const first = words[0]
  if (
    position === 0 &&
    first?.value === 'schema' &&
    !root.commands.some((child) => child.name === 'schema')
  ) {
    return { kind: 'schema', consumed: [first.index] }
  }

  while (node.kind === 'group' && position < words.length) {
    const word = words[position] as Word
    const group: Group = node
    const child = group.commands.find(
      (candidate) => candidate.name === word.value
    )
    if (!child) {
      return {
        kind: 'unknown',
        group,
        path,
        word: word.value,
        suggestion: closest(
          word.value,
          group.commands.map((candidate) => candidate.name)
        ),
      }
    }
    node = child
    path.push(child.name)
    consumed.push(word.index)
    position++
  }
  return { kind: 'node', node, path, consumed }
}

/** Returns the candidate within a small edit distance of `input`, if any. */
export function closest(
  input: string,
  candidates: string[]
): string | undefined {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(input.length / 3)) + 1
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Levenshtein distance between two strings. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length] as number
}
