import {
  type AnyCommand,
  type CliOptions,
  type Group,
  isBuiltin,
} from './define.ts'
import { DefinitionError } from './errors.ts'
import {
  BUILTINS,
  FRAMEWORK_FLAGS,
  type FrameworkFlag,
  findNode,
  flagTokens,
  route,
} from './route.ts'
import { type CommandSpec, type FieldSpec, resolveSpec } from './spec.ts'

/** Shells with a completion script. */
export const SHELLS = ['bash', 'zsh', 'fish'] as const

/** A shell supported by `completion`. */
export type Shell = (typeof SHELLS)[number]

/** The hidden built-in the completion scripts call on each Tab. */
export const COMPLETE_COMMAND = '__complete'

/** Output that tells the completion script to complete file paths. */
const FILES = ':files'

/** A completion candidate. */
interface Candidate {
  value: string
  description?: string
}

/** Values completed for an option or positional, or file paths. */
type Values = Candidate[] | typeof FILES

/** A flag a command accepts, for completion. */
interface Option {
  flag: string
  description: string | undefined
  /** The next argument is the flag's value. */
  takesValue: boolean
  values: Values
  /** May be given more than once. */
  repeatable: boolean
  /** Offered as a candidate; positional fields are accepted but not offered. */
  offered: boolean
}

/**
 * Lists the framework flags a command accepts, or the global ones for a
 * group. `--version` is offered only at the root, `-h` never.
 */
function frameworkOptions(
  command: AnyCommand | undefined,
  isRoot = false
): Option[] {
  const accepted = (flag: FrameworkFlag) =>
    flag.global
      ? flag.name !== 'version' || isRoot
      : command !== undefined && (flag.when?.(command) ?? true)
  return FRAMEWORK_FLAGS.filter(accepted).flatMap((flag) =>
    flagTokens(flag)
      .filter((token) => token.startsWith('--'))
      .map((token) => ({
        flag: token,
        description: flag.description,
        takesValue: flag.value !== undefined,
        values: flag.value
          ? (flag.value.choices?.map((value) => ({ value })) ?? FILES)
          : [],
        repeatable: false,
        offered: true,
      }))
  )
}

/** Returns `true` for a supported shell name. */
export function isShell(value: string | undefined): value is Shell {
  return SHELLS.includes(value as Shell)
}

/**
 * Answers the hidden `__complete` built-in: `words` are the arguments after
 * the binary name, the last being the word under the cursor. Returns one
 * `value<TAB>description` line per candidate, or `:files` for file paths.
 */
export function complete(
  cli: CliOptions,
  root: Group,
  words: string[]
): string {
  const current = words.at(-1) ?? ''
  let values: Values
  try {
    values = candidates(cli, root, words.slice(0, -1), current)
  } catch {
    // A broken definition must not print errors into the user's prompt.
    return ''
  }
  if (values === FILES) {
    return `${FILES}\n`
  }
  return values
    .filter(({ value }) => value.startsWith(current) && !/[\t\n\r]/.test(value))
    .map(
      ({ value, description }) =>
        `${value}${description ? `\t${description.replace(/\s+/g, ' ')}` : ''}\n`
    )
    .join('')
}

/** Lists candidates for the word after `before`. */
function candidates(
  cli: CliOptions,
  root: Group,
  before: string[],
  current: string
): Values {
  const routed = route(root, before, cli.aliases)
  if (routed.kind === 'unknown') {
    return []
  }
  const words = routed.rest.filter((arg) => !arg.startsWith('-'))
  if (routed.kind === 'builtin') {
    return words.length === 0 ? SHELLS.map((value) => ({ value })) : []
  }
  const { node, path, rest } = routed
  if (isBuiltin(node) && node.name === 'schema' && !current.startsWith('-')) {
    const target = findNode(root, words)
    return target?.kind === 'group' ? children(cli, target, false) : []
  }
  if (node.kind === 'group') {
    if (current.startsWith('-')) {
      return flagCandidates(frameworkOptions(undefined, path.length === 0), [])
    }
    return children(cli, node, path.length === 0)
  }
  return commandCandidates(resolveSpec(node, path.join(' ')), rest, current)
}

/** Lists the commands of a group, with aliases and built-ins at the root. */
function children(cli: CliOptions, group: Group, isRoot: boolean): Candidate[] {
  const list: Candidate[] = group.commands
    .filter((child) => !isBuiltin(child))
    .map((child) => ({ value: child.name, description: child.description }))
  if (!isRoot) {
    return list
  }
  for (const [alias, target] of Object.entries(cli.aliases ?? {})) {
    if (!alias.includes(' ')) {
      list.push({ value: alias, description: `Alias for ${target}` })
    }
  }
  for (const [name, { description }] of Object.entries(BUILTINS)) {
    const shadowed = group.commands.some(
      (child) => child.name === name && !isBuiltin(child)
    )
    if (!shadowed) {
      list.push({ value: name, description })
    }
  }
  return list
}

/** Lists candidates within a command: flag values, flags, or positionals. */
function commandCandidates(
  spec: CommandSpec,
  rest: string[],
  current: string
): Values {
  const options = commandOptions(spec)
  const byFlag = new Map(options.map((option) => [option.flag, option]))
  const used: string[] = []
  let positional = 0
  let pending: Option | undefined
  let terminated = false
  for (const arg of rest) {
    if (pending) {
      pending = undefined
    } else if (terminated || arg === '-' || !arg.startsWith('-')) {
      positional++
    } else if (arg === '--') {
      terminated = true
    } else {
      const flag = arg.split('=')[0] as string
      used.push(flag)
      const option = byFlag.get(flag)
      if (option?.takesValue && !arg.includes('=')) {
        pending = option
      }
    }
  }
  if (pending) {
    return pending.values
  }
  if (!terminated && current.startsWith('-')) {
    const equals = current.indexOf('=')
    if (equals === -1) {
      return flagCandidates(options, used)
    }
    const values = byFlag.get(current.slice(0, equals))?.values
    if (!values || values === FILES) {
      return []
    }
    const prefix = current.slice(0, equals + 1)
    return values.map((candidate) => ({ value: `${prefix}${candidate.value}` }))
  }
  const last = spec.positionals.at(-1)
  const field =
    spec.positionals[positional] ?? (last?.variadic ? last : undefined)
  if (field) {
    return fieldValues(field)
  }
  return terminated || current !== '' ? [] : flagCandidates(options, used)
}

/** Lists the offered flags that may still be given. */
function flagCandidates(options: Option[], used: string[]): Candidate[] {
  return options
    .filter(
      (option) =>
        option.offered && (option.repeatable || !used.includes(option.flag))
    )
    .map(({ flag, description }) => ({ value: flag, description }))
}

/** Lists every flag a command accepts, framework flags last. */
function commandOptions(spec: CommandSpec): Option[] {
  const options: Option[] = spec.fields
    .filter((field) => !field.secret)
    .map((field) => ({
      flag: `--${field.flag}`,
      description: field.description,
      takesValue: field.kind !== 'boolean',
      values: fieldValues(field),
      repeatable: field.kind === 'array',
      offered: !field.positional,
    }))
  return [...options, ...frameworkOptions(spec.command)]
}

/** Lists the values of a field: its enum, file paths for strings, or nothing. */
function fieldValues(field: FieldSpec): Values {
  if (field.enum) {
    return field.enum.map((value) => ({ value: String(value) }))
  }
  const kind = field.kind === 'array' ? field.itemKind : field.kind
  return kind === 'string' || kind === 'unknown' ? FILES : []
}

/**
 * Returns the completion script for a shell. The script asks the CLI for
 * candidates on each Tab through `__complete`, so it never goes stale.
 *
 * @see https://www.gnu.org/software/bash/manual/html_node/Programmable-Completion.html
 * @see https://zsh.sourceforge.io/Doc/Release/Completion-System.html
 * @see https://fishshell.com/docs/current/completions.html
 */
export function completionScript(name: string, shell: Shell): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new DefinitionError(
      'completion',
      `the CLI name "${name}" cannot be used in a completion script`
    )
  }
  const id = name.replace(/[^A-Za-z0-9_]/g, '_')
  const header = `# ${shell} completion for ${name}, printed by \`${name} completion ${shell}\`.\n# Candidates come from \`${name} ${COMPLETE_COMMAND}\`, so they match the installed version.\n`
  if (shell === 'bash') {
    return `${header}_${id}_complete() {
  local line="\${COMP_LINE:0:COMP_POINT}" cur="\${COMP_WORDS[COMP_CWORD]}"
  local -a words
  read -ra words <<< "$line"
  if [[ -z $line || $line == *[[:space:]] ]]; then
    words+=('')
  fi
  local output
  output="$(${name} ${COMPLETE_COMMAND} "\${words[@]:1}" 2>/dev/null)" || return 0
  COMPREPLY=()
  if [[ $output == '${FILES}' ]]; then
    # compopt (bash 4+) quotes names and marks directories; bash 3.2 quotes here.
    local file quote=
    compopt -o filenames 2>/dev/null || quote=1
    while IFS= read -r file; do
      [[ -n $quote ]] && printf -v file '%q' "$file"
      COMPREPLY+=("$file")
    done < <(compgen -f -- "$cur")
    return 0
  fi
  # Bash splits words at "=" and ":"; complete only the part after them.
  local last="\${words[\${#words[@]}-1]}" prefix candidate
  prefix="\${last%"$cur"}"
  while IFS=$'\\t' read -r candidate _; do
    if [[ -n $candidate && $candidate == "$prefix"* ]]; then
      COMPREPLY+=("\${candidate#"$prefix"}")
    fi
  done <<< "$output"
}
complete -F _${id}_complete ${name}
`
  }
  if (shell === 'zsh') {
    return `#compdef ${name}
${header}_${id}() {
  local -a lines items
  local line value description
  lines=("\${(@f)$(${name} ${COMPLETE_COMMAND} "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ \${lines[1]} == '${FILES}' ]]; then
    _files
    return
  fi
  for line in "\${lines[@]}"; do
    [[ -n $line ]] || continue
    value=\${line%%$'\\t'*}
    description=\${line#*$'\\t'}
    if [[ $description == "$line" ]]; then
      items+=("\${value//:/\\\\:}")
    else
      items+=("\${value//:/\\\\:}:$description")
    fi
  done
  (( \${#items} )) && _describe -t values value items
}
if [[ "\${funcstack[1]}" == _${id} ]]; then
  _${id} "$@"
else
  compdef _${id} ${name}
fi
`
  }
  return `${header}function __${id}_complete
    set -l tokens (commandline -opc)
    set -e tokens[1]
    set -l current (commandline -ct)
    set -l output (${name} ${COMPLETE_COMMAND} $tokens "$current" 2>/dev/null)
    if test "$output[1]" = '${FILES}'
        __fish_complete_path "$current"
        return
    end
    for line in $output
        echo $line
    end
end
complete -c ${name} -f -a '(__${id}_complete)'
`
}

/** Help for the `completion` built-in, with installation steps. */
export function completionHelp(name: string): string {
  return `${name} completion: Print a shell completion script

Usage:
  ${name} completion <${SHELLS.join('|')}>

Install:
  bash  Add to ~/.bashrc:  eval "$(${name} completion bash)"
  zsh   Add to ~/.zshrc after compinit:  source <(${name} completion zsh)
  fish  ${name} completion fish > ~/.config/fish/completions/${name}.fish

The script asks ${name} for candidates on each Tab, so it stays current after upgrades.
`
}
