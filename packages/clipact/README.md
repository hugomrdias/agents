# clipact

A small framework for Node.js CLIs that agents and humans can both rely on. It implements the [CLI guidelines for agents](../../docs/agent-cli-guidelines.md) once, following the [framework design](../../docs/cli-framework-design.md), so every command gets the same contract by default:

- one compact JSON result on stdout in machine mode, human text otherwise, and diagnostics on stderr;
- exit code `0` when `ok` is `true` and `1` otherwise, with signals re-raised as `128 + N`;
- structured errors with stable codes, a `retryable` flag, and `next` steps for the agent or the user;
- one input schema that drives flags, positionals, `--input` JSON, environment fallbacks, validation, help, and JSON Schema discovery;
- agent detection that changes presentation only, and confirmation gates that agents cannot bypass;
- lazy handlers, so `--help`, `--version`, and `schema` stay fast.

The only runtime dependency is the types-only [`@standard-schema/spec`](https://standardschema.dev). Requires Node.js 24 or newer.

For a complete CLI that uses every feature, with esbuild bundling and the compile-cache shim, see the [launchpad example](../../examples/launchpad/README.md).

## Contents

- [Quick start](#quick-start)
- [Features](#features)
  - [Output contract](#output-contract)
  - [Modes and agent detection](#modes-and-agent-detection)
  - [Input](#input)
  - [Secrets](#secrets)
  - [Side effects and confirmation](#side-effects-and-confirmation)
  - [Errors](#errors)
  - [Long-running work and signals](#long-running-work-and-signals)
  - [Help and discovery](#help-and-discovery)
  - [Shell completions](#shell-completions)
  - [Built-in flags and variables](#built-in-flags-and-variables)
- [API reference](#api-reference)
- [Testing API](#testing-api)
- [Performance](#performance)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Quick start

Keep definitions and handlers in separate modules. Definitions import only the schema library; handlers import SDKs and load only when their command runs.

```ts
// commands.ts
import * as z from 'zod'
import { defineCommand, defineGroup } from 'clipact'

/** Publishes a file and returns a link. */
export const put = defineCommand({
  name: 'put',
  description: 'Publish a file and return a link',
  examples: ['acme artifacts put ./report.pdf'],
  input: z.strictObject({
    path: z.string().describe('File to publish'),
    copies: z.number().int().min(1).max(5).default(2).describe('Committed copies'),
    network: z.enum(['mainnet', 'calibration']).default('calibration').describe('Target network'),
    privateKey: z.string().describe('Signing key'),
  }),
  positionals: ['path'],
  env: { network: 'ACME_NETWORK', privateKey: 'ACME_PRIVATE_KEY' },
  secrets: ['privateKey'],
  output: z.object({ ref: z.string(), url: z.url() }),
  errors: ['insufficient_funds'],
  confirm: (input) => (input.network === 'mainnet' ? `Spends mainnet funds for ${input.copies} copies.` : undefined),
  dryRun: true,
  handler: () => import('./put.run.js'),
})

export const commands = [
  defineGroup({ name: 'artifacts', description: 'Publish and manage artifacts', commands: [put] }),
]
```

```ts
// put.run.ts
import { CliError, defineHandler } from 'clipact'
import { put } from './commands.js'

export default defineHandler(put, async (ctx) => {
  const { path, copies } = ctx.input // typed from the input schema, defaults applied
  if (ctx.dryRun) {
    return ctx.ok({ ref: 'dry-run', url: 'https://example.com/dry-run' })
  }
  ctx.progress({ phase: 'upload', message: `Uploading ${path}` })
  const ref = await upload(path, copies, { signal: ctx.signal })
  if (!ref) {
    throw new CliError({
      code: 'insufficient_funds',
      message: 'The payer cannot cover the lockup.',
      next: [{ by: 'user', command: 'acme auth fund', description: 'Add funds' }],
    })
  }
  return ctx.ok({ ref, url: `https://example.com/${ref}` }) // typed from the output schema
})
```

```ts
// main.ts
import { defineCli } from 'clipact'
import { commands } from './commands.js'

defineCli({
  name: 'acme',
  version: '1.0.0',
  description: 'Example publishing CLI',
  commands,
  aliases: { publish: 'artifacts put' },
  mapError: () => import('./map-error.js'),
}).run()
```

Point `bin` at a small entry shim that enables the compile cache and imports the bundled CLI dynamically (a statically imported module is not cached):

```js
#!/usr/bin/env node
import module from 'node:module'

module.enableCompileCache?.()
await import('../dist/main.js')
```

```sh
$ ACME_PRIVATE_KEY=… acme artifacts put ./report.pdf --json
{"ok":true,"ref":"bafy…","url":"https://example.com/bafy…"}
```

## Features

### Output contract

Every invocation produces one result object. Command fields sit beside a small envelope:

```json
{"ok":true,"ref":"ref-2","url":"https://example.com/a","next":[{"by":"agent","command":"acme artifacts get ref-2","description":"Inspect it"}]}
```

```json
{"ok":false,"error":{"code":"insufficient_funds","message":"The payer cannot cover the lockup.","retryable":false},"next":[{"by":"user","command":"acme auth fund","description":"Add funds"}]}
```

| Field | Meaning |
| --- | --- |
| `ok` | `true` only when the command succeeded. Decides the exit code. |
| `error` | `{ code, message, retryable, retryAfterSeconds?, details? }` when `ok` is `false`. |
| `next` | Optional follow-up steps. `by: "agent"` steps are runnable by the agent; `by: "user"` steps mean a human must act, and the agent should stop and relay them. |
| Command fields | The handler's data on success, or `CliError.data` as partial results on failure. `ok`, `error`, and `next` are reserved. |

Where things go:

| | Machine mode (`json`) | Human mode (`human`) |
| --- | --- | --- |
| stdout | The result as one compact JSON line, written once, after all stderr output | The formatted result on success; nothing on failure |
| stderr | A one-line summary on failure; progress, logs, and `--debug` | Errors, issue lists, usage, `Next:` steps, progress, logs |
| Exit code | `0` if `ok`, else `1` | Same |

The process exits by setting `process.exitCode`, never by `process.exit()`, so piped output is never truncated. A closed stdout pipe (`acme … | head`) ends the process quietly.

In human mode, a command's optional `human(data)` formatter renders the result; without one, fields print as `key: value`, with nested values as indented JSON:

```text
$ acme artifacts put a --format human
acme: upload: Uploading a
ref: ref-2
url: https://example.com/a
Next:
  Inspect it
    acme artifacts get ref-2
```

### Modes and agent detection

The format is resolved in this order; the first match wins:

1. `--json` or `--format json|human`. `--json` with `--format human` is `invalid_input`.
2. `<PREFIX>_OUTPUT=json|human`.
3. A detected agent → `json`.
4. A non-TTY stdout → `json`; otherwise `human`.

Agents are detected from `AI_AGENT` and `AGENT` (their value is the agent name, or `unknown` for `1`/`true`), then from vendor variables: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CODEX_THREAD_ID`, `CODEX_CI`, `GEMINI_CLI`, `CURSOR_AGENT`, `OPENCODE`, `AUGMENT_AGENT`, `COPILOT_AGENT_SESSION_ID`, `AMP_CURRENT_THREAD_ID`, and `QWEN_CODE_SESSION_ID`. `--agent`/`--no-agent` and `<PREFIX>_AGENT=1|0|true|false` override detection. `CI` and `TERM` are not agent signals.

Detection changes presentation only:

| Behavior | Human | Agent |
| --- | --- | --- |
| Default format | `human` on a terminal | `json`, even in a PTY |
| Color and status lines | On a TTY (respecting `NO_COLOR` and `FORCE_COLOR`) | Off |
| Prompts | When stdin and stdout are TTYs and no agent or `CI` is detected | Never |
| Help | Narrative with global flags | Examples first, output fields, error codes, side effects, `schema` pointer |
| Usage errors | Usage line on stderr | Full command help (or group help, for an unknown or missing subcommand) on stderr, then the JSON result |
| Progress | Rewritten status line | A plain line at most every 15 s |

It never changes permissions, confirmations, exit codes, the JSON shape, or which operation runs.

Invalid framework variables (`ACME_OUTPUT=yaml`, `ACME_AGENT=maybe`) make a command fail with `invalid_input` naming the variable, but `--help`, `--version`, and `schema` ignore them so discovery always works.

### Input

A command declares one object schema for everything it accepts. Values are collected from these sources, highest precedence first:

1. **Flags** and **positionals**. Every field is a kebab-case flag (`privateKey` → `--private-key`); fields listed in `positionals` may also be given positionally, in order.
2. **`--input <file|->`**, a JSON object read from a file or stdin. A field given both here and on the command line is `invalid_input` instead of silently picking one.
3. **Environment fallbacks** from `env`, read only when the field is still missing and only for the command being run.
4. **Schema defaults**, applied by validation.

Command-line strings are converted to the field's JSON Schema type before validation:

| Field type | Command line | Environment variable |
| --- | --- | --- |
| `string`, enum | As given | As given |
| `number`, `integer` | Decimal only: `3`, `-1.5`, `2e3`. Anything else (`0x10`, ` 5`, empty) is passed through as a string for the schema to reject | Same |
| `boolean` | `--force`, `--no-force`, `--force=true\|false\|1\|0` | `true`, `false`, `1`, `0` |
| `array` | Repeat the flag (`--tag a --tag b`), or a variadic last positional | Comma-separated |
| `object` | JSON (`--meta '{"a":1}'`) | JSON |
| Union of several types | As given | As given |

Positional rules, checked when a command is first resolved: each positional names an input field; only the last may be an array (a variadic such as `label <id> <labels...>`); required positionals come before optional ones; booleans, objects, and secrets cannot be positional. Only one source may read stdin, so `--input -` with a `-` argument is rejected.

Values from flags, positionals, and environment variables may not contain control characters other than tab, line feed, and carriage return; ANSI escapes or NUL in a command line usually mean a garbled argument. `--input` JSON is exempt, since it can encode any text deliberately. When `--input` cannot be read or parsed, only that problem is reported, not every field it would have provided. Reading `--input -` stops when the command is interrupted, so an open stdin never blocks a SIGTERM.

All problems are reported at once, using field names and the source of each value (`flag`, `positional`, `input`, `env:NAME`). An unknown flag gets a suggestion, and the value after it is not reported a second time as an extra argument:

```sh
$ acme artifacts put --copies 9 --entri x
acme: --entri: Unknown flag; did you mean --entry? (and 3 more).
```

```json
{"ok":false,"error":{"code":"invalid_input","message":"--entri: Unknown flag; did you mean --entry? (and 3 more).","retryable":false,"details":[{"path":"--entri","source":"flag","message":"Unknown flag; did you mean --entry?"},{"path":"path","message":"Required; pass <path> or --path"},{"path":"copies","source":"flag","message":"Too big: expected number to be <=5"},{"path":"privateKey","message":"Required; set ACME_PRIVATE_KEY"}]}}
```

`--debug` prints each value's source on stderr before the handler runs:

```text
debug: input for artifacts put
  path = "a" (positional)
  copies = 2 (default)
  network = "calibration" (default)
  privateKey = <redacted> (env:ACME_PRIVATE_KEY)
```

Use `z.strictObject` so unknown `--input` keys are rejected as well.

### Secrets

Fields listed in `secrets` must have an `env` mapping and come only from that variable, so they never appear in process listings, shell history, or agent transcripts. As a flag or an `--input` key they are `invalid_input`; `--debug` shows `<redacted>`; help lists them under **Environment**; `schema` names them in `secrets` and drops their defaults and examples.

### Side effects and confirmation

| Property | Effect |
| --- | --- |
| `readOnly: true` | The command changes no state. Implies `idempotent`. Cannot be combined with `confirm`. |
| `idempotent: true` | Repeating it with the same input has no additional effect. |
| `confirm` | A reason string, or a function of the validated input that returns one or `undefined`. |
| `dryRun: true` | Accepts `--dry-run` and sets `ctx.dryRun`; the handler must skip side effects. |

When `confirm` yields a reason and neither `--yes` nor `--dry-run` was given:

- **A human is present** (interactive, no agent): `<reason> Continue? [y/N]` on stderr. Declining returns `confirmation_required` with the message `Confirmation declined.`.
- **Otherwise**: the command fails without side effects. The `next` step repeats the exact command line with `--yes`, shell-quoted and placed before any `--`:

```json
{"ok":false,"error":{"code":"confirmation_required","message":"Spends mainnet funds for 2 copies. Confirm with --yes.","retryable":false,"details":{"reason":"Spends mainnet funds for 2 copies."}},"next":[{"by":"user","command":"acme artifacts put a.txt --yes","description":"Approve this action, then run it with --yes"}]}
```

Agent detection never relaxes the gate. `--yes` and `--dry-run` are unknown flags on commands that do not declare `confirm` or `dryRun`.

### Errors

Throw a `CliError` for expected failures. Its code should be listed in the command's `errors`; strict tests enforce this.

| Code | Raised by | `retryable` |
| --- | --- | --- |
| `invalid_input` | Parsing, validation, unknown commands, invalid framework flags or variables | `false` |
| `confirmation_required` | The confirmation gate | `false` |
| `interrupted` | SIGINT, SIGTERM, SIGHUP | `true` only for `readOnly` or `idempotent` commands |
| `internal_error` | Anything unexpected | `false` |
| `rate_limited`, `service_unavailable`, `timeout` | Handlers | Default `true` only for `readOnly` or `idempotent` commands |
| Your codes | Handlers | Default `false` |

An explicit `retryable` always wins. The framework never retries; handlers and SDKs own request-level retries and backoff, and return `retryable: true` only when the same command can be run again safely.

Other thrown values go to the optional `mapError` hook, loaded lazily on the first such error, so SDK error classes are not imported at startup:

```ts
// map-error.ts
import { CliError } from 'clipact'
import { NotFoundError } from 'some-sdk'

export default function mapError(error: unknown): CliError | undefined {
  if (error instanceof NotFoundError) {
    return new CliError({ code: 'not_found', message: error.message })
  }
  return undefined // becomes internal_error
}
```

An unmapped error becomes `internal_error` with the message `Unexpected error: <message>` and a user step to report it with `--debug`. Stack traces appear only with `--debug`, on stderr. Uncaught exceptions and unhandled rejections during `run()` become the same result, and `ctx.signal` is aborted so pending handler I/O does not keep the process alive.

Mistakes in definitions (a missing field, a clash with a framework flag, a handler module without a `defineHandler` default export, a handler that does not return `ctx.ok()`) also surface as `internal_error`. Catch them in tests with `assertDefinitions`.

### Long-running work and signals

- `ctx.progress({ phase, message, data? })` reports progress on stderr. On a human terminal it rewrites one status line; otherwise it prints `acme: <phase>: <message>`, at most every 15 seconds, which also keeps harness inactivity timers alive.
- `ctx.checkpoint({ id, next })` registers a job before side effects start. The ID is printed to stderr immediately, so it survives even a SIGKILL: `acme: started op_1; if interrupted, run: acme operations resume op_1`.
- `ctx.signal` is aborted on the first SIGINT, SIGTERM, or SIGHUP. Pass it to `fetch`, timers, child processes, and SDK calls. When the handler rejects after the abort, the CLI writes an `interrupted` result with the latest checkpoint's `next` steps, then re-raises the signal so the shell sees `130`, `143`, or `129`:

```json
{"ok":false,"error":{"code":"interrupted","message":"Interrupted by SIGTERM.","retryable":false},"next":[{"by":"agent","command":"acme operations resume op_1","description":"Resume the operation"}]}
```

Listeners are registered with `process.once`, so a second signal terminates immediately. Persist operation state as work progresses rather than in a signal handler; harnesses send SIGKILL 50–200 ms after SIGTERM.

### Help and discovery

| Command | Output |
| --- | --- |
| `acme --version` | The version, on stdout |
| `acme --help`, `acme <group> --help` | Every command below that point, with descriptions |
| `acme <command> --help` | Usage, arguments, flags with defaults and variables, secrets, examples, side effects |
| `acme schema --list` | `{ ok, name, version, commands: [{ command, description, readOnly, idempotent, confirm, dryRun }], aliases }` |
| `acme schema <command>` | `{ ok, command, description, examples, positionals, env, secrets, readOnly, idempotent, confirm, dryRun, input, output, errors, aliases }`, where `input` and `output` are JSON Schema 2020-12 and `confirm` is `null`, `{ when: 'always', reason }`, or `{ when: 'conditional' }` |
| `acme completion <bash\|zsh\|fish>` | A shell completion script, on stdout in every mode (see [Shell completions](#shell-completions)) |

None of these load handlers, read credentials, or touch the network. In human mode, `schema` pretty-prints its JSON. A group run without a subcommand prints its help for humans and returns `invalid_input` listing its commands for machines. An unknown command suggests the closest name:

```json
{"ok":false,"error":{"code":"invalid_input","message":"Unknown command \"acme artifact\". Did you mean \"artifacts\"?","retryable":false},"next":[{"by":"agent","command":"acme artifacts --help","description":"Show help for \"artifacts\""},{"by":"agent","command":"acme schema --list","description":"List all commands"}]}
```

Agent help for a command:

```text
acme artifacts get: Show an artifact

Usage:
  acme artifacts get <id>

Arguments:
  id  Artifact ID

Flags:
  --input <file|->  Read input fields from a JSON object

Output fields: id (string), size (number)

Error codes: not_found, invalid_input, confirmation_required, interrupted, internal_error, rate_limited, service_unavailable, timeout

Read-only; safe to retry.

Output is one JSON object on stdout; exit code 0 when "ok" is true, else 1.
Full schema: acme schema artifacts get
```

### Shell completions

`acme completion bash|zsh|fish` prints a short script. Install it once:

```sh
# bash 3.2+ (~/.bashrc)
eval "$(acme completion bash)"
# zsh (~/.zshrc, after compinit)
source <(acme completion zsh)
# fish
acme completion fish > ~/.config/fish/completions/acme.fish
```

On each Tab, the script runs the hidden `acme __complete <words…>`, which answers from the definitions without loading handlers, so completions always match the installed version. It completes:

- commands, groups, single-word aliases, and the `schema` and `completion` built-ins, with descriptions in zsh and fish;
- a command's flags, except positional fields, secrets, and flags already given (array flags repeat), followed by the framework flags;
- values of `--flag value` and `--flag=value` from the field's `enum`, file paths for string fields and `--input`, and nothing for numbers;
- positionals the same way, in order, then flags once every positional is filled.

`acme completion` without a shell prints these installation steps for humans and returns `invalid_input` for machines. `__complete` prints one `value<TAB>description` line per candidate, or `:files` for file paths, and always exits `0`.

### Built-in flags and variables

| Flag | Where | Effect |
| --- | --- | --- |
| `--json` | Anywhere before `--` | Machine mode |
| `--format human\|json` | Anywhere before `--` | Choose the format |
| `--agent`, `--no-agent` | Anywhere before `--` | Override agent detection |
| `--debug` | Anywhere before `--` | Input sources and stack traces on stderr |
| `-h`, `--help` | Anywhere before `--` | Help for the routed command or group |
| `--version` | Anywhere before `--` | Print the version |
| `--input <file\|->` | Commands | Read input fields from JSON |
| `--yes` | Commands with `confirm` | Skip the confirmation |
| `--dry-run` | Commands with `dryRun` | Set `ctx.dryRun` and skip the confirmation |

Input fields cannot use these names (`json`, `format`, `agent`, `input`, `yes`, `dryRun`, `debug`, `help`, `version`), and the root cannot define a `schema` or `completion` command without replacing the built-in one.

| Variable | Values | Effect |
| --- | --- | --- |
| `<PREFIX>_OUTPUT` | `json`, `human` | Default format |
| `<PREFIX>_AGENT` | `1`, `0`, `true`, `false` | Force or disable agent mode |
| `AI_AGENT`, `AGENT`, vendor variables | Any | Agent detection |
| `CI` | Set and not `0`/`false` | No prompts |
| `NO_COLOR`, `FORCE_COLOR`, `TERM` | Standard | Color in human mode |

`<PREFIX>` is `envPrefix`, or the CLI name upper-cased with other characters replaced by `_` (`acme` → `ACME`).

## API reference

Everything below is exported from `clipact` unless marked `clipact/testing`.

### `defineCli(options): Cli`

Creates a CLI from its command tree.

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Binary name, used in help, messages, and `next` commands. |
| `version` | `string` | Printed by `--version` and `schema --list`. |
| `description` | `string?` | Shown in root help. |
| `envPrefix` | `string?` | Prefix of framework variables. Defaults to the name. |
| `commands` | `CommandNode[]` | Top-level commands and groups. |
| `aliases` | `Record<string, string>?` | Extra paths for canonical paths, such as `{ publish: 'artifacts put' }`. Multi-word aliases are allowed; help, `schema`, and errors use the canonical path. |
| `mapError` | `() => Promise<{ default: MapError }>`? | Lazily imports the error translation hook. |

The returned `Cli`:

| Member | Description |
| --- | --- |
| `run(argv = process.argv): Promise<void>` | Runs with the real process: installs signal, EPIPE, and crash handlers, sets `process.exitCode`, and re-raises an interrupting signal. Slices the first two `argv` entries. |
| `execute(args, io, options?): Promise<Outcome>` | Runs one invocation against injected streams without touching the process. `args` excludes `node` and the script. Used by `invoke`. |
| `options` | The `CliOptions` given to `defineCli`. |
| `envPrefix` | The resolved prefix, such as `ACME`. |

`ExecuteOptions`: `signal?: AbortSignal` (abort with a signal name such as `'SIGTERM'` as the reason to interrupt), `crash?: Promise<never>` (rejects with an uncaught error), `strict?: boolean` (contract checks). `Outcome`: `{ exitCode: 0 | 1, result, signal }`, where `result` is the result object (undefined for help and version) and `signal` is the signal to re-raise.

`Io`: `{ env, stdin, stdout, stderr }`, where the output streams need only `write(chunk, callback)` and an optional `isTTY`.

### `defineCommand(options): Command`

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | One word; the path is the group names plus this name. |
| `description` | `string` | One line, used in help and `schema --list`. |
| `examples` | `string[]?` | Runnable command lines; first in agent help. |
| `input` | `Schema?` | Object schema for all input. Omitted means the command takes no input. |
| `positionals` | `Field[]?` | Input fields that may be positional, in order. |
| `env` | `{ [field]?: string }?` | Environment variables used as fallbacks. |
| `secrets` | `Field[]?` | Fields read only from their `env` variable. |
| `output` | `Schema?` | Schema of the success data; types `ctx.ok()` and appears in `schema`. |
| `errors` | `string[]?` | Command-specific error codes. |
| `readOnly` | `boolean?` | Changes no state; implies `idempotent`. |
| `idempotent` | `boolean?` | Safe to repeat with the same input. |
| `confirm` | `string \| (input) => string \| undefined`? | Confirmation reason. |
| `dryRun` | `boolean?` | Supports `--dry-run`. |
| `human` | `(data) => string`? | Human-mode formatter for success data. |
| `handler` | `() => Promise<unknown>` | Imports the module whose default export is a `defineHandler` result. |

`Schema` is `StandardSchemaV1 & StandardJSONSchemaV1`: any library that validates and exports JSON Schema through [Standard JSON Schema](https://standardschema.dev/json-schema), such as zod 4 (`import * as z from 'zod'`). Field names, `env` keys, and `secrets` are type-checked against the input schema.

`defineCommand` throws a `TypeError` for `readOnly` with `confirm` and for a secret without an `env` mapping. Field-level checks run when the command is first resolved; see `assertDefinitions`.

### `defineGroup({ name, description, commands }): Group`

Groups commands under a word, such as `artifacts` in `acme artifacts put`. Groups nest.

### `defineHandler(command, run): Handler`

Pairs a handler with its definition for typing. Default-export the result from the module that the command's `handler` imports. `run(ctx)` may be async and must return `ctx.ok(...)` or throw.

`Context`:

| Member | Description |
| --- | --- |
| `input` | Validated input with defaults and transforms applied (`ParsedOf<input>`). |
| `signal` | `AbortSignal` aborted on the first SIGINT, SIGTERM, or SIGHUP, or after a crash. |
| `mode` | `{ format: 'json' \| 'human', agent: string \| false, interactive: boolean }`. |
| `dryRun` | `true` when `--dry-run` was given. |
| `progress({ phase, message, data? })` | Progress on stderr; see [Long-running work](#long-running-work-and-signals). |
| `log(message)` | Writes a line to stderr in any mode. |
| `checkpoint({ id, next? })` | Prints the job ID now and uses `next` if interrupted. |
| `ok(data, { next? }?)` | Creates the success result. `data` is typed by `output`; without an output schema it is optional. |

### `CliError`

```ts
new CliError({ code, message, retryable?, retryAfterSeconds?, details?, next?, data?, cause? })
```

| Option | Description |
| --- | --- |
| `code` | Stable `snake_case` code. |
| `message` | One actionable sentence. |
| `retryable` | Overrides the default from the [errors table](#errors). |
| `retryAfterSeconds` | Delay before retrying. |
| `details` | Structured context, such as a list of issues. |
| `next` | Follow-up steps. |
| `data` | Partial command output, rendered beside `error`. |
| `cause` | The underlying error, not rendered. |

`isCliError(value)` also recognizes `CliError` instances from another copy of the module.

### Other exports

| Export | Description |
| --- | --- |
| `detectAgent(env): string \| false` | The agent detection used for modes. |
| `BUILTIN_ERROR_CODES` | The built-in codes, appended to every command's `errors` in help and `schema`. |
| `MapError` | `(error: unknown) => CliError \| undefined \| Promise<…>`. |
| `Next` | `{ by: 'agent' \| 'user', description, command? }`. |
| `ErrorBody` | `{ code, message, retryable, retryAfterSeconds?, details? }`. |
| `InputIssue` | `{ path, message, source? }`, the items of `invalid_input` details. |
| `InputOf<S>`, `ParsedOf<S>`, `DataOf<S>` | Input before parsing, input after parsing, and handler data for a schema. |
| `Command`, `AnyCommand`, `Group`, `CommandNode`, `CommandOptions`, `CliOptions`, `Context`, `Handler`, `Ok`, `Mode`, `ProgressEvent`, `Checkpoint`, `Schema`, `Io`, `OutputStream`, `Env`, `Outcome`, `ExecuteOptions` | Types used above. |

## Testing API

`clipact/testing` works with the Node test runner and any assertion library.

| Export | Description |
| --- | --- |
| `invoke(cli, args, options?)` | Runs in process with captured streams. Options: `env` (empty by default so the runner's agent variables do not leak in), `stdin` (text or a stream), `tty`, `signal`, `strict` (default `true`). Returns `RunResult & { outcome }`. |
| `exec(bin, args, options?)` | Spawns `node <bin> …` without a TTY and with only `PATH` set. Options: `env`, `stdin`, `keepStdinOpen`, `kill: { signal, when?, afterMs? }` (sends the signal once stderr contains `when`, or after `afterMs`), `timeoutMs`. |
| `assertContract(result)` | Asserts stdout is exactly one compact JSON object with a boolean `ok`, the exit code matches `ok`, stdout has no ANSI codes, and stderr has no JSON. Returns the parsed result. |
| `assertDefinitions(cli)` | Resolves every command and fails with all definition errors at once. |
| `schemas(cli)` | Every command's `schema` output keyed by path, for snapshot tests. |

`RunResult` is `{ exitCode, signal, stdout, stderr, json }`; `exitCode` is `null` when the run ended by a signal.

Strict mode, used by `invoke`, turns contract violations into `internal_error` results so tests fail clearly: output that does not match the `output` schema, error codes not in `errors` or the built-ins, data using `ok`, `error`, or `next`, and `retryable: true` from a command that is neither `readOnly` nor `idempotent`.

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertContract, assertDefinitions, exec, invoke } from 'clipact/testing'
import { cli } from '../src/main.ts'

test('definitions are valid', () => assertDefinitions(cli))

test('put publishes a file', async () => {
  const result = await invoke(cli, ['artifacts', 'put', 'a.txt'], { env: { ACME_PRIVATE_KEY: 'k' } })
  assert.equal(assertContract(result).ok, true)
})

test('SIGTERM yields an interrupted result', async () => {
  const result = await exec('bin/acme.js', ['operations', 'wait'], {
    kill: { signal: 'SIGTERM', when: 'started' },
  })
  assert.equal(result.signal, 'SIGTERM')
  assert.equal((assertContract(result).error as { code: string }).code, 'interrupted')
})
```

## Performance

The framework core is 13 small modules with no runtime dependencies besides the types-only spec package. Measured on Node.js v26.10.0 with a warm compile cache, for a two-command zod CLI bundled with esbuild (`--bundle --splitting --format=esm`, handlers as separate chunks), as time over `node -e ''`:

| Path | Measured | Budget |
| --- | --- | --- |
| Import the framework | +6 ms | |
| `--version` | +9 ms | ≤ 10 ms |
| `--help` | +8 ms | ≤ 20 ms |
| `schema <command>` | +10 ms | ≤ 20 ms |
| A command, excluding its own dependencies | +14 ms | ≤ 25 ms |

Unbundled, the same CLI costs 27–33 ms, mostly from loading zod's modules. Bundle for release, keep SDK imports in handlers, and use `import * as z from 'zod'` rather than `import { z }`, which pulls in every locale.

## Not yet implemented

From the [design](../../docs/cli-framework-design.md#milestones): telemetry (`telemetry` commands, `DO_NOT_TRACK`), `skills install|status|uninstall`, a startup-budget check in CI, and NDJSON `--events`. Prompts beyond confirmation, output formats other than JSON and text, and MCP are out of scope.

## Development

```sh
pnpm --filter clipact check
```

Tests in `test/` run a fixture CLI (`test/fixtures`) in process and as a real process, covering results, validation, secrets, `--input`, confirmation, errors, modes, discovery, signals, and crashes.
