import type { AnyCommand, CliOptions, CommandNode, Group } from './define.ts'
import { CliError, DefinitionError, type Next } from './errors.ts'

/** A flag owned by the framework rather than a command's input. */
export interface FrameworkFlag {
  /** Name without dashes. */
  name: string
  description: string
  /** Placeholder and choices when the flag takes a value. */
  value?: { label: string; choices?: readonly string[] }
  /** Single-letter alias, such as `h` for `-h`. */
  short?: string
  /** Also accepted as `--no-<name>`. */
  negatable?: boolean
  /** Accepted anywhere, including by built-in commands. */
  global?: boolean
  /** Accepted only by commands that support it. */
  when?: (command: AnyCommand) => boolean
}

/**
 * Every framework flag, command flags first. Parsing, routing, help, and
 * completion all derive from this list.
 */
export const FRAMEWORK_FLAGS: readonly FrameworkFlag[] = [
  {
    name: 'yes',
    description: 'Confirm without a prompt',
    when: (command) => Boolean(command.confirm),
  },
  {
    name: 'dry-run',
    description: 'Report what would happen without side effects',
    when: (command) => command.dryRun === true,
  },
  {
    name: 'input',
    description: 'Read input fields from a JSON object',
    value: { label: '<file|->' },
  },
  {
    name: 'json',
    description: 'Write one JSON result to stdout',
    global: true,
  },
  {
    name: 'format',
    description: 'Choose the output format',
    value: { label: '<human|json>', choices: ['human', 'json'] },
    global: true,
  },
  {
    name: 'agent',
    description: 'Override agent detection',
    negatable: true,
    global: true,
  },
  {
    name: 'debug',
    description: 'Show input sources and stack traces on stderr',
    global: true,
  },
  { name: 'help', description: 'Show help', short: 'h', global: true },
  { name: 'version', description: 'Show the version', global: true },
]

/** Returns the raw tokens of a flag, such as `-h` and `--help`. */
export function flagTokens(flag: FrameworkFlag): string[] {
  return [
    ...(flag.short ? [`-${flag.short}`] : []),
    `--${flag.name}`,
    ...(flag.negatable ? [`--no-${flag.name}`] : []),
  ]
}

/**
 * Classifies a raw argument as a framework flag that takes its value from
 * the next argument (`value`), one complete in itself (`switch`), or neither.
 */
export function frameworkToken(arg: string): 'value' | 'switch' | undefined {
  for (const flag of FRAMEWORK_FLAGS) {
    if (flag.value) {
      if (arg === `--${flag.name}`) {
        return 'value'
      }
      if (arg.startsWith(`--${flag.name}=`)) {
        return 'switch'
      }
    } else if (flagTokens(flag).includes(arg)) {
      return 'switch'
    }
  }
  return undefined
}

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
  | { kind: 'node'; node: CommandNode; path: string[]; rest: string[] }
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
      const token = frameworkToken(arg)
      if (!token) {
        break
      }
      if (token === 'value') {
        index++
      }
      continue
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
 * reached, resolving aliases.
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
  return { kind: 'node', node, path, rest: without(args, consumed) }
}

/** Builds the error for an unknown command word. */
export function unknownCommand(
  cli: CliOptions,
  routed: Extract<Route, { kind: 'unknown' }>
): CliError {
  const attempted = [cli.name, ...routed.path, routed.word].join(' ')
  const next: Next[] = []
  if (routed.suggestion) {
    next.push({
      by: 'agent',
      command: [cli.name, ...routed.path, routed.suggestion, '--help'].join(
        ' '
      ),
      description: `Show help for "${routed.suggestion}"`,
    })
  }
  next.push({
    by: 'agent',
    command: `${cli.name} schema --list`,
    description: 'List all commands',
  })
  return new CliError({
    code: 'invalid_input',
    message: `Unknown command "${attempted}".${routed.suggestion ? ` Did you mean "${routed.suggestion}"?` : ''}`,
    retryable: false,
    next,
  })
}

/** Returns `args` without the given indexes. */
function without(args: string[], indexes: number[]): string[] {
  return args.filter((_, index) => !indexes.includes(index))
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
