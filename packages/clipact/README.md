# clipact

clipact is a small framework for Node.js CLIs that both coding agents and people run. It implements the [CLI guidelines for agents](../../docs/agent-cli/guidelines.md) once, so every command follows the same contract by default:

- In machine mode, a command writes one compact JSON result to stdout. In human mode, it writes text. Diagnostics always go to stderr.
- A result has `data` on success or `error` on failure. The exit code is `0` or `1` to match, and an interrupting signal is re-raised so the shell sees `128 + N`.
- An error carries a stable code from one registry, a `retryable` flag, and `next` steps for the agent or the user.
- One input schema drives flags, positionals, `--input` JSON, environment fallbacks, validation, help, and JSON Schema discovery.
- Agent detection changes presentation only. An agent cannot skip a confirmation.
- Handlers load lazily, so `--help`, `--version`, and `schema` never import handler code or SDKs.

The only runtime dependency is the types-only [`@standard-schema/spec`](https://standardschema.dev). clipact requires Node.js 24 or newer. The [framework design](../../docs/agent-cli/framework-design.md) explains why it works this way.

The [launchpad example](../../examples/launchpad/README.md) is a complete CLI that uses every feature, with esbuild bundling and the compile-cache shim.

## Contents

- [Quick start](#quick-start)
- [Features](#features)
  - [Output contract](#output-contract)
  - [Modes and agent detection](#modes-and-agent-detection)
  - [Input](#input)
  - [Secrets](#secrets)
  - [Globals](#globals)
  - [Storage](#storage)
  - [Side effects and confirmation](#side-effects-and-confirmation)
  - [Errors](#errors)
  - [Long-running work and signals](#long-running-work-and-signals)
  - [Help and discovery](#help-and-discovery)
  - [Shell completions](#shell-completions)
  - [Agent skills](#agent-skills)
  - [Telemetry](#telemetry)
  - [Built-in flags and variables](#built-in-flags-and-variables)
- [API reference](#api-reference)
- [Testing API](#testing-api)
- [Performance](#performance)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Quick start

Keep definitions and handlers in separate modules. A definition imports only the schema library. A handler imports SDKs, and clipact loads it only when its command runs.

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
  mapError: () => import('./map-error.js'),
  errors: {
    insufficient_funds: { description: 'The payer cannot cover the storage lockup.' },
  },
}).run()
```

Point `bin` at a small entry shim that enables the compile cache and then imports the bundled CLI. Use a dynamic `import()`, because a static import loads before `enableCompileCache()` runs:

```js
#!/usr/bin/env node
import module from 'node:module'

module.enableCompileCache?.()
await import('../dist/main.js')
```

In machine mode, the command prints one line:

```sh
$ ACME_PRIVATE_KEY=… acme artifacts put ./report.pdf --json
{"data":{"ref":"bafy…","url":"https://example.com/bafy…"}}
```

## Features

### Output contract

Every invocation produces one result object with exactly one of `data` and `error`, then optional `next` steps, and no other top-level keys:

```json
{"data":{"ref":"ref-2","url":"https://example.com/a"},"next":[{"by":"agent","command":"acme artifacts get ref-2","description":"Inspect it"}]}
```

```json
{"error":{"code":"insufficient_funds","message":"The payer cannot cover the lockup.","retryable":false},"next":[{"by":"user","command":"acme auth fund","description":"Add funds"}]}
```

| Key | Meaning |
| --- | --- |
| `data` | The value passed to `ctx.ok()`, on success only. It is an object, or an array when the `output` schema says so. It is `{}` when the handler passes nothing. |
| `error` | `{ code, message, retryable, retryAfterSeconds?, details? }`, on failure only. A failed command returns no `data`. Recovery context goes in `details` and `next`. |
| `next` | Optional follow-up steps. The agent can run a `by: "agent"` step itself. A `by: "user"` step needs a human, so the agent stops and relays it. |

Each mode sends output to these streams:

| | Machine mode (`json`) | Human mode (`human`) |
| --- | --- | --- |
| stdout | The result as one compact JSON line, written once, after all stderr output | The formatted result on success. Nothing on failure. |
| stderr | A one-line summary on failure, plus progress, logs, and `--debug` output | Errors, issue lists, usage, `Next:` steps, progress, and logs |
| Exit code | `0` with `data`, `1` with `error` | Same |

The CLI sets `process.exitCode` instead of calling `process.exit()`, so piped output is never truncated. The one exception is a closed stdout pipe, such as `acme … | head`. The CLI then exits with code `0` and writes nothing more.

In human mode, the command's optional `human(data)` formatter renders the result. Without a formatter, each field prints as `key: value`, and nested values print as indented JSON. An array result prints as indented JSON:

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

clipact picks the format from the first of these that applies:

1. `--json` or `--format json|human`. `--json` with `--format human` is `invalid_input`.
2. `<PREFIX>_OUTPUT=json|human`.
3. A detected agent selects `json`.
4. A stdout that is not a TTY selects `json`. Otherwise, the format is `human`.

clipact detects an agent from `AI_AGENT` and `AGENT` first. Their value is the agent name, and `1` or `true` gives the name `unknown`. A value of the form `<name>_<version>_agent`, such as Claude Code's `claude-code_2-1-299_agent`, gives the name `claude-code`; the version must start with a digit, so `my_custom_agent` stays one name. It then checks these vendor variables: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CODEX_THREAD_ID`, `CODEX_CI`, `GEMINI_CLI`, `CURSOR_AGENT`, `OPENCODE`, `AUGMENT_AGENT`, `COPILOT_AGENT_SESSION_ID`, `AMP_CURRENT_THREAD_ID`, and `QWEN_CODE_SESSION_ID`. `--agent`, `--no-agent`, and `<PREFIX>_AGENT=1|0|true|false` override detection. `CI` and `TERM` do not signal an agent.

Detection changes presentation only:

| Behavior | Human | Agent |
| --- | --- | --- |
| Default format | `human` on a terminal | `json`, even in a PTY |
| Color and status lines | On a TTY, respecting `NO_COLOR` and `FORCE_COLOR` | Off |
| Prompts | When stdin and stdout are TTYs and neither an agent nor `CI` is detected | Never |
| Help | Narrative, with global flags | Examples first, then output fields, error codes, side effects, and a pointer to `schema` |
| Usage errors | Usage line on stderr. A missing subcommand gets the group's help. | Full command help on stderr, then the JSON result. An unknown or missing subcommand gets the group's help. |
| Progress | Rewritten status line, with the elapsed time once it stays quiet | A plain line for every event, repeated with its elapsed time after 15 s of quiet and then every 30 s |

Detection never changes permissions, confirmations, exit codes, the JSON shape, or which operation runs.

An invalid framework variable, such as `ACME_OUTPUT=yaml` or `ACME_AGENT=maybe`, makes a command fail with `invalid_input` that names the variable. `--help`, `--version`, and `schema` ignore invalid variables, so discovery still works.

### Input

A command declares one object schema for everything it accepts. clipact reads values from these sources, highest precedence first:

1. **Flags and positionals.** Every field is a kebab-case flag, so `privateKey` becomes `--private-key`. Fields listed in `positionals` can also be given by position, in order.
2. **`--input <file|->`.** A JSON object read from a file or stdin. A field given both here and on the command line is `invalid_input`, so clipact never silently picks one.
3. **Environment fallbacks.** clipact reads a field's `env` variable only when the field is still missing, and only for the command being run.
4. **Schema defaults.** Validation applies them.

Before validation, clipact converts each command-line string to the field's JSON Schema type:

| Field type | Command line | Environment variable |
| --- | --- | --- |
| `string`, enum | As given | As given |
| `number`, `integer` | Decimal only, such as `3`, `-1.5`, or `2e3`. Any other value, such as `0x10`, ` 5`, or an empty string, stays a string, and the schema rejects it. | Same |
| `boolean` | `--force`, `--no-force`, `--force=true\|false\|1\|0` | `true`, `false`, `1`, `0` |
| `array` | Repeat the flag (`--tag a --tag b`), or use a variadic last positional | Comma-separated |
| `object` | JSON (`--meta '{"a":1}'`) | JSON |
| Union of several types | As given | As given |

clipact checks these positional rules when a command is first resolved:

- Each positional names an input field.
- Only the last positional can be an array, which makes it variadic, such as `<labels...>` in `label <id> <labels...>`.
- Required positionals come before optional ones.
- Booleans, objects, and secrets cannot be positional.

Only one source can read stdin, so `--input -` together with a `-` argument is `invalid_input`.

Values from flags, positionals, and environment variables cannot contain control characters other than tab, line feed, and carriage return. An ANSI escape or a NUL in a command line usually means a garbled argument. `--input` JSON is exempt, because JSON can encode any text on purpose. When `--input` cannot be read or parsed, clipact reports only that problem, not every field the JSON would have provided. Reading `--input -` stops when the command is interrupted, so an open stdin never blocks a SIGTERM.

clipact reports all problems at once, with field names and the source of each value: `flag`, `positional`, `input`, or `env:NAME`. An unknown flag gets a suggestion, and clipact does not report the value after it a second time as an extra argument:

```sh
$ acme artifacts put --copies 9 --entri x
acme: --entri: Unknown flag; did you mean --entry? (and 3 more).
```

```json
{"error":{"code":"invalid_input","message":"--entri: Unknown flag; did you mean --entry? (and 3 more).","retryable":false,"details":[{"path":"--entri","source":"flag","message":"Unknown flag; did you mean --entry?"},{"path":"path","message":"Required; pass <path> or --path"},{"path":"copies","source":"flag","message":"Too big: expected number to be <=5"},{"path":"privateKey","message":"Required; set ACME_PRIVATE_KEY"}]}}
```

When a value is not a member of a field's `enum`, or of the `enum` of an array field's items, the issue lists the allowed values in `expected`. clipact reads them from the field's JSON Schema, so this works with any schema library:

```json
{"path":"network","source":"flag","message":"Invalid option: expected one of \"mainnet\"|\"calibration\"","expected":["mainnet","calibration"]}
```

`--debug` prints the source of each value on stderr before the handler runs:

```text
debug: input for artifacts put
  path = "a" (positional)
  copies = 2 (default)
  network = "calibration" (default)
  privateKey = <redacted> (env:ACME_PRIVATE_KEY)
```

To reject unknown `--input` keys too, use `z.strictObject`.

### Secrets

A field listed in `secrets` must have an `env` mapping and comes only from that variable, so its value never appears in process listings, shell history, or agent transcripts. clipact handles a secret field this way:

- As a flag or an `--input` key, it is `invalid_input`.
- `--debug` shows `<redacted>` for its value.
- Help lists it under **Environment**.
- `schema` names it in `secrets` and leaves out its default and examples.

### Globals

Settings that every command uses, such as an API URL, are globals. Define them once with `defineGlobals`, pass them to `defineCli`, and read them in a handler with `globals.get(ctx)`:

```ts
// src/globals.ts
import { defineGlobals } from 'clipact'
import * as z from 'zod'

export const globals = defineGlobals({
  input: z.object({
    apiUrl: z.url().default('https://api.acme.dev').describe('API endpoint'),
    retries: z.number().int().min(0).default(3).describe('Request retries'),
  }),
  env: { apiUrl: 'ACME_API_URL', retries: 'ACME_RETRIES' },
})

// src/cli.ts:     defineCli({ name: 'acme', version, globals, commands })
// in a handler:   const { apiUrl, retries } = globals.get(ctx)
```

clipact handles globals this way:

- They come only from environment variables, never from flags or `--input`. Every field needs an `env` name, written out in full. `envPrefix` is not applied.
- Values are converted like [environment fallbacks](#input), then validated against the globals schema, which applies its defaults.
- Every command reads them, except `schema`, `completion`, and the framework's `telemetry` commands, so an invalid global never blocks an opt-out. `--help` and `--version` ignore them. An invalid or missing value is `invalid_input` before the command's own input is read, reported together with invalid framework variables. Each issue's `path` is the variable, such as `ACME_RETRIES`, and a missing value reads `Required; set ACME_RETRIES`.
- `globals.get(ctx)` returns the typed values. It throws a `TypeError` for the context of a CLI defined without these globals.
- Fields listed in `secrets` show `<redacted>` in `--debug` output, and `schema` leaves out their defaults and examples.
- Root help lists them under **Environment**, before the framework variables. `schema --list` publishes them under `globals`. `--debug` prints `debug: globals` with the source of each value.
- `defineCli` throws a `TypeError` when a global uses `<PREFIX>_OUTPUT`, `<PREFIX>_AGENT`, `<PREFIX>_TELEMETRY`, or `<PREFIX>_CONFIG_DIR`. `assertDefinitions` also reports a variable that a command's `env` uses too.

When a setting also needs a flag, declare it as an input field of each command instead, with a shared schema fragment.

### Storage

Every CLI has one folder for the files it keeps between runs, named after the CLI:

| OS | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/acme` |
| Linux and other systems | `$XDG_DATA_HOME/acme`, default `~/.local/share/acme` |
| Windows | `%LOCALAPPDATA%\acme` |

`<PREFIX>_CONFIG_DIR` replaces it with an absolute path. A relative path is `invalid_input` and an empty value counts as unset, so the folder never depends on the working directory. `XDG_DATA_HOME` counts only outside macOS and Windows, and only when it is absolute.

The folder holds three kinds of files:

- `clipact.json`, clipact's own file: the saved [telemetry](#telemetry) choice, whether the notice was shown, and the installation ID. Don't write it.
- `config.json`, the CLI's store, when it defines one.
- Any file the CLI adds itself, such as a database.

`await ctx.dir()` returns the folder, creating it with mode `0700` on the first call, because it may hold credentials. `await ctx.dir({ create: false })` returns the path without creating anything, such as for a `doctor` command. Both throw `state_unwritable` when there is no folder, with neither `HOME` (`LOCALAPPDATA` on Windows) nor `<PREFIX>_CONFIG_DIR` set, and `ctx.dir()` also throws it when the folder cannot be created. Nothing creates the folder until a command needs it, so `--help`, `schema`, and `telemetry status` work in read-only sandboxes.

For settings and state the CLI saves, such as a login or a default network, define a store. It is one JSON file read and written with [iso-conf](https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf):

```ts
// src/store.ts
import { defineStore } from 'clipact'
import * as z from 'zod'

export const store = defineStore({
  schema: z.object({
    network: z.enum(['mainnet', 'calibration']).optional(),
    sessions: z.record(z.string(), z.string()).default({}),
  }),
})

// src/cli.ts:     defineCli({ name: 'acme', version, store, commands })
// in a handler:   const conf = await store.get(ctx)
//                 conf.set('network', 'mainnet')
```

clipact handles the store this way:

- `await store.get(ctx)` returns an iso-conf `Conf` for `config.json` in the folder. clipact imports iso-conf only then, so other commands, `--help`, and `schema` never load it.
- Reading never writes. A missing file reads as the schema's defaults and creates no file. clipact creates the folder when it opens the store, if it can, and reads still work when it cannot.
- Each write is atomic, gives the file mode `0600`, and holds a lock, so parallel runs of the CLI do not lose each other's changes.
- A corrupt file, or one that fails the schema, is `config_invalid` with the file's `path`. A write the folder refuses is `state_unwritable`. A lock that another process holds for more than a second is `timeout`. A command that uses the store declares `state_unwritable` and `config_invalid` in its `errors`.
- The store never fills command input. A handler that falls back to a saved value, such as the default network, reads the store itself.
- `store.get(ctx)` throws a `TypeError` for the context of a CLI defined without this store. `defineStore` throws one for the name `clipact`, in any case, which is reserved.

### Side effects and confirmation

| Property | Effect |
| --- | --- |
| `readOnly: true` | The command changes no state. Implies `idempotent`. Cannot be combined with `confirm`. |
| `idempotent: true` | Repeating the command with the same input has no additional effect. |
| `confirm` | A reason string, or a function of the validated input that returns one or `undefined`. |
| `dryRun: true` | Accepts `--dry-run` and sets `ctx.dryRun`. The handler must then skip side effects. |

When `confirm` returns a reason and the command line has neither `--yes` nor `--dry-run`, the result depends on who is running the command:

- If a human is present, meaning the terminal is interactive and no agent is detected, clipact prints `<reason> Continue? [y/N]` on stderr. A "no" answer returns `confirmation_required` with the message `Confirmation declined.`
- Otherwise, the command fails without side effects. Its `next` step repeats the exact command line with `--yes`, shell-quoted and placed before any `--`:

```json
{"error":{"code":"confirmation_required","message":"Spends mainnet funds for 2 copies. Confirm with --yes.","retryable":false,"details":{"reason":"Spends mainnet funds for 2 copies."}},"next":[{"by":"user","command":"acme artifacts put a.txt --yes","description":"Approve this action, then run it with --yes"}]}
```

Agent detection never skips the confirmation. `--yes` is an unknown flag on a command without `confirm`, and `--dry-run` is an unknown flag on a command without `dryRun`.

### Errors

Declare every error code once, in the `errors` registry of `defineCli`. Give each code a one-sentence description. When its `details` has a fixed shape, also give a `details` schema. Each command lists the codes it can return in its own `errors`. `schema <command>` publishes those codes with their descriptions and `details` JSON Schemas, so an agent knows what a code means before it sees one.

```ts
defineCli({
  // …
  errors: {
    insufficient_funds: { description: 'The payer cannot cover the storage lockup.' },
    file_not_found: {
      description: 'A file to publish does not exist.',
      details: z.array(z.object({ path: z.string(), message: z.string() })),
    },
  },
})
```

Throw a `CliError` for an expected failure. In strict mode, clipact checks that the command declares the code and that `details` matches the registry's schema for it. `assertDefinitions` checks that every declared code is in the registry. `defineCli` throws a `TypeError` for a registry entry that redefines a built-in code, and exposes the full registry as `cli.errors`.

| Code | Raised by | `retryable` |
| --- | --- | --- |
| `invalid_input` | Parsing, validation, unknown or missing commands, and invalid framework flags or variables | `false` |
| `confirmation_required` | The confirmation | `false` |
| `interrupted` | SIGINT, SIGTERM, SIGHUP | `true` only for `readOnly` or `idempotent` commands |
| `internal_error` | Anything unexpected | `false` |
| `rate_limited`, `service_unavailable`, `timeout` | Handlers | Default `true` only for `readOnly` or `idempotent` commands |
| `skill_conflict` | `skills install`, when `skills` is configured (see [Agent skills](#agent-skills)) | `false` |
| `state_unwritable` | `ctx.dir()`, store writes, `telemetry enable`, and `telemetry disable` (see [Storage](#storage)) | `false` |
| `config_invalid` | Reading a store file that is corrupt or fails its schema (see [Storage](#storage)) | `false` |
| Your codes | Handlers | Default `false` |

An explicit `retryable` always wins. clipact never retries. Handlers and SDKs own request-level retries and backoff, and a handler sets `retryable: true` only when the same command is safe to run again.

A thrown value that is not a `CliError` goes to the optional `mapError` hook. clipact imports the hook module only when such an error happens, so startup never imports SDK error classes:

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

An unmapped error becomes `internal_error` with the message `Unexpected error: <message>` and a `by: "user"` step to report it with `--debug`. Stack traces appear only with `--debug`, on stderr. An uncaught exception or an unhandled rejection during `run()` becomes the same result. clipact also aborts `ctx.signal`, so pending handler I/O does not keep the process alive.

A mistake in a definition or a handler module also becomes `internal_error`. Examples are a missing field, a clash with a framework flag, a handler module without a `defineHandler` default export, and a handler that does not return `ctx.ok()`. `assertDefinitions` catches the definition mistakes in tests. A test that runs the command with `invoke` catches the handler mistakes.

### Long-running work and signals

- `ctx.progress({ phase, message, data? })` reports progress on stderr. On a human terminal, it rewrites one status line. Otherwise, it prints `acme: <phase>: <message>` for every event. Report each change once, not every chunk or poll.
- clipact keeps the output alive. When stderr has been quiet for 15 seconds, it repeats the latest event with its elapsed time, such as `acme: commit: Waiting for confirmation (45 s)`, and then repeats it every 30 seconds until another line or the result. These lines reset the inactivity timers of agent harnesses, so a handler never re-emits an event to look alive. A human terminal shows the elapsed time in the status line.
- clipact does not print `data` yet. Put anything the reader needs in `message`.
- To register a job, call `ctx.checkpoint({ id, next })` before side effects start. clipact prints the ID to stderr at once, so the ID survives even a SIGKILL: `acme: started op_1; if interrupted, run: acme operations resume op_1`.
- clipact aborts `ctx.signal` on the first SIGINT, SIGTERM, or SIGHUP. Pass it to `fetch`, timers, child processes, and SDK calls. When the handler rejects after the abort, the CLI writes an `interrupted` result with the latest checkpoint's `next` steps. It then re-raises the signal, so the shell sees `130`, `143`, or `129`:

```json
{"error":{"code":"interrupted","message":"Interrupted by SIGTERM.","retryable":false},"next":[{"by":"agent","command":"acme operations resume op_1","description":"Resume the operation"}]}
```

clipact registers its signal listeners with `process.once`, so a second signal ends the process at once. Save operation state as the work progresses, not in a signal handler. Agent harnesses send SIGKILL 50 to 200 ms after SIGTERM.

### Help and discovery

| Command | Output |
| --- | --- |
| `acme --version` | The version, on stdout |
| `acme --help`, `acme <group> --help` | Every command below that point, with descriptions. Root help also has an **Environment** section: each [global](#globals), then `<PREFIX>_OUTPUT`, `<PREFIX>_AGENT`, `<PREFIX>_CONFIG_DIR`, and, with [telemetry](#telemetry), `<PREFIX>_TELEMETRY`. |
| `acme <command> --help` | Usage, arguments, flags with defaults and variables, secrets, examples, and side effects. With globals, a line points to root help for them. |
| `acme schema --list` | `data` is `{ name, version, commands: [{ command, description, readOnly, idempotent, confirm, dryRun }], env, globals, result }`. `env` is `{ output, agent, telemetry, config }`, the framework variable names. `globals` is `{ env, secrets, input }`, as in `schema <command>`, and only appears when the CLI has globals. `env` and `globals` appear only for the root. `result` is the JSON Schema of the result envelope. |
| `acme schema <command>` | `data` is `{ command, description, examples, positionals, env, secrets, readOnly, idempotent, confirm, dryRun, input, output, errors }`. `input` and `output` are JSON Schema 2020-12, and `output` describes `data`. `errors` maps each code to `{ description, details }`. `confirm` is `null`, `{ when: 'always', reason }`, or `{ when: 'conditional' }`. |
| `acme completion <bash\|zsh\|fish>` | A shell completion script, on stdout in every mode (see [Shell completions](#shell-completions)) |

None of these commands loads handlers, reads credentials, or uses the network. In human mode, `schema` pretty-prints its `data`.

The root or a group run without a subcommand, such as `acme` or `acme artifacts`, is a usage error in every mode, so agent detection never changes its exit code. Human mode prints the group's help and the error on stderr. Machine mode returns `invalid_input` whose `command` issue lists the group's commands in `expected`, with a `next` step for the group's `schema`. `--help` prints the same help on stdout and exits `0`.

```json
{"error":{"code":"invalid_input","message":"Missing command after \"acme artifacts\".","retryable":false,"details":[{"path":"command","message":"Missing command","expected":["artifacts put","artifacts get","artifacts ls","artifacts label"]}]},"next":[{"by":"agent","command":"acme schema artifacts","description":"List the \"artifacts\" commands with descriptions"}]}
```

An unknown command gets the same `expected` list, and suggests the closest name:

```json
{"error":{"code":"invalid_input","message":"Unknown command \"acme artifact\". Did you mean \"artifacts\"?","retryable":false,"details":[{"path":"command","message":"Unknown command \"artifact\"","expected":["artifacts put","artifacts get","artifacts ls","artifacts label"]}]},"next":[{"by":"agent","command":"acme artifacts --help","description":"Show help for \"artifacts\""},{"by":"agent","command":"acme schema --list","description":"List all commands with descriptions"}]}
```

`acme schema <path>` reports a path that names no command or group in the same way. The error names the deepest group the path matched, so `acme schema artifacts nope` lists only the `artifacts` commands and points to `acme schema artifacts`. Words after a command, such as `acme schema artifacts put extra`, are also `invalid_input`.

Agent help for a command looks like this:

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

Output is one JSON object on stdout: "data" on success (exit code 0) or "error" on failure (exit code 1), then optional "next" steps.
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

On each Tab, the script runs the hidden `acme __complete <words…>` command. That command answers from the definitions without loading handlers, so completions always match the installed version. `__complete` suggests these candidates:

- Commands, groups, and the `schema` and `completion` built-ins. zsh and fish also show descriptions.
- A command's flags, then the framework flags. It leaves out positional fields, secrets, and flags already given. Array flags can repeat.
- Values for `--flag value` and `--flag=value`. These are the field's `enum` values, or file paths for string fields and `--input`. Numbers get no candidates.
- Positionals, the same way and in order, then flags once every positional is filled.

Without a shell argument, `acme completion` prints the installation steps in human mode and returns `invalid_input` in machine mode. `__complete` prints one `value<TAB>description` line per candidate, or `:files` for file paths, and always exits `0`.

### Agent skills

To ship hand-written [Agent Skills](https://agentskills.io/specification), put each one in the package as `skills/<name>/SKILL.md` and point `skills` at that directory:

```ts
defineCli({ name: 'acme', version: '1.0.0', commands, skills: new URL('../skills/', import.meta.url) })
```

This adds a `skills` group. Help, `schema`, and completions list it like any other group:

| Command | Behavior |
| --- | --- |
| `acme skills install [--scope project\|global] [--target agents\|claude]… [--force] [--dry-run]` | Copies each bundled skill to `.agents/skills/<name>/` and `.claude/skills/<name>/` under the current directory, or under the home directory with `--scope global`. Idempotent. An up-to-date copy is reported as `unchanged`. |
| `acme skills status [--scope project\|global]` | Reports every copy in both scopes, or in one, as `missing`, `current`, `stale` (another version or different content), `edited`, `unmanaged`, or `symlink`, with the version that installed it. |
| `acme skills uninstall [--scope …] [--target …] [--dry-run]` | Removes the files that `install` wrote and that nobody edited since, and lists the edited files under `kept`. It reports copies it does not touch as `missing`, `unmanaged`, or `symlink`. |

Each installed directory gets a `.clipact.json` manifest with the CLI name, the version, and a SHA-256 hash of every file. Files keep their permission bits, so shipped scripts stay executable.

`install` checks every directory before it writes to any. It returns `skill_conflict`, with a `by: "user"` step to rerun with `--force`, when a directory has any of these problems:

- It has edited files.
- It has a local file that the new version would overwrite.
- It has no manifest, because someone wrote it by hand or another tool installed it.

clipact ignores a manifest that lists a path outside its directory, so that copy counts as unmanaged.

`install` never writes through a symbolic link, even with `--force`. A link inside the skill directory is a `skill_conflict` until you remove it. So is a linked `.claude` or `.agents` directory that resolves outside the current directory, or outside the home directory for `--scope global`. For a linked directory, the conflict reports where it `resolvesTo` and suggests copying the skills by hand or installing into the other scope.

`install` replaces each installed file instead of writing into it, so read-only files update too. `uninstall` and `--force` delete only files whose content still matches the manifest. No other command installs skills.

When another version installed the project copy, the CLI prints one stderr line after each command in human mode:

```text
acme: the installed "acme" skill is from version 0.9.0; run "acme skills install" to update it.
```

If the root defines its own `skills` command or group, clipact does not add the built-in one.

### Telemetry

To collect usage events, point `telemetry.sender` at a module that sends them:

```ts
defineCli({ name: 'acme', version: '1.0.0', commands, telemetry: { sender: new URL('./telemetry.js', import.meta.url) } })
```

```ts
// telemetry.ts
import type { TelemetrySender } from 'clipact'

const send: TelemetrySender = async (event, { signal }) => {
  await fetch('https://telemetry.example.com/events', { method: 'POST', body: JSON.stringify(event), signal })
}
export default send
```

After the result is written, clipact starts a detached, unref'd Node.js process that imports the sender module and calls its default export with the event. The command never waits for it, and its errors never reach the user. The sender's `signal` aborts after 10 seconds, and the process then exits. The module must exist as a file at run time, so when you bundle the CLI, make the sender its own entry point. A string `sender` must be a `file:` URL or an absolute path; `defineCli` throws for a relative path, which would resolve against the user's working directory. The application owns the endpoint and the request format.

Telemetry is on by default. The first run that sends an event prints one line to stderr, in every mode, and the event is sent in that same run. A saved `telemetry enable` counts as having seen it:

```text
acme: this CLI sends usage data (command and flag names, error codes, versions; never values). Turn it off with "acme telemetry disable" or DO_NOT_TRACK=1.
```

Set `default: 'off'` to make telemetry opt-in, and `docs` to a page that lists the fields, which the notice links. Any opt-out wins:

1. `DO_NOT_TRACK` set to anything other than empty, `0`, or `false`
2. `<PREFIX>_TELEMETRY=0` or `false`
3. `acme telemetry disable`

Then `<PREFIX>_TELEMETRY=1`, `true`, or `log` and `acme telemetry enable` turn telemetry on, and `default` decides the rest. `<PREFIX>_TELEMETRY=log` prints each event to stderr instead of sending it. `--debug` prints each event, waits for the sender, and prints its errors. `CODEX_SANDBOX_NETWORK_DISABLED` turns telemetry off unless `<PREFIX>_TELEMETRY=log`, and `telemetry status` then reports `enabled: false` with that variable; it is not an opt-out, so `optedOut` stays `false`. clipact also sends nothing on an interruption, for shell completion, or for the `telemetry` commands themselves.

The configured CLI gets a `telemetry` group:

| Command | Behavior |
| --- | --- |
| `acme telemetry status` | Reports `{ enabled, optedOut, source, variable? }`. `source` is `env`, `config`, or `default`, and `variable` names the environment variable behind the answer. |
| `acme telemetry enable` | Saves the choice to send events and reports the resulting status, which an environment opt-out may still override. Idempotent. |
| `acme telemetry disable` | Saves the choice to send nothing. Idempotent. |

clipact saves the choice, whether the notice was shown, and the installation ID in `clipact.json`, in the CLI's [folder](#storage). `enable` and `disable` return `state_unwritable` when it cannot be written. When it cannot be read or written, as in sandboxes, clipact treats it as empty, shows the notice again, and sends `installId: null`. A corrupt file also reads as empty, and the next write keeps a copy of it as `clipact.invalid-<timestamp>.json`. Writes hold a lock, so parallel first runs save one installation ID.

clipact 0.5 kept this state in `state.json` in the platform state folder. clipact now ignores that file, so each user sees the notice once more and gets a new installation ID.

Each event is a `TelemetryEvent`:

| Field | Value |
| --- | --- |
| `eventVersion` | `1` |
| `cli.name`, `cli.version` | The CLI's `name` and `version` |
| `command` | The routed path, such as `artifacts put`. For an unknown command, the path of its group. |
| `flags` | Sorted names of known flags typed before `--`, such as `["dry-run", "json"]`. Arguments are read as the command parser reads them, so in `--message --json`, `--json` is a value. Values, positionals, and unknown names are never recorded. |
| `errorCode` | The error code of a failed command, or `null` on success |
| `durationMs`, `timestamp` | Time until the result was written, and when it was written as an ISO 8601 string |
| `env.node`, `env.os`, `env.arch` | `process.versions.node`, `process.platform`, `process.arch` |
| `env.mode` | `ci` when `CI` is set, otherwise `interactive` or `noninteractive` |
| `env.provider` | The CI or deployment provider, such as `github_actions`, `gitlab`, or `vercel`, from a table copied from [std-env](https://github.com/unjs/std-env/blob/v4.3.0/src/providers.ts). `null` when none is detected. |
| `env.format` | `json` or `human` |
| `env.agent`, `env.agentVersion` | The detected or forced agent, and its version when `AI_AGENT` or `AGENT` carries one, such as `2-1-299` |
| `installId` | A random UUID saved in `clipact.json`. `null` in CI, whose home directory rarely outlives the job, and when it cannot be saved. |

Events carry no agent session ID or hash, so they cannot be linked into one agent session's sequence of calls.

A handler can read the same status with `await ctx.telemetry()`. Check `optedOut` before the application's own reporting, such as an agent header on API requests. Never change a command's output or behavior based on it. It works without a `telemetry` option too: `enabled` is then `false` with source `unconfigured`, and `optedOut` reads only `DO_NOT_TRACK` and `<PREFIX>_TELEMETRY`.

If the root defines its own `telemetry` command or group, clipact does not add the built-in one and still sends events.

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

An input field cannot use a framework flag's name: `json`, `format`, `agent`, `input`, `yes`, `dryRun`, `debug`, `help`, or `version`. A root `schema` or `completion` command replaces the built-in one.

| Variable | Values | Effect |
| --- | --- | --- |
| `<PREFIX>_OUTPUT` | `json`, `human` | Default format |
| `<PREFIX>_AGENT` | `1`, `0`, `true`, `false` | Force or disable agent mode |
| `<PREFIX>_CONFIG_DIR` | An absolute path | The CLI's [folder](#storage) |
| [Globals](#globals) | Per the globals schema | CLI-wide settings |
| `AI_AGENT`, `AGENT`, vendor variables | Any | Agent detection |
| `CI` | Set, non-empty, and not `0` or `false` | No prompts |
| `DO_NOT_TRACK` | Set, non-empty, and not `0` or `false` | Turn telemetry off |
| `<PREFIX>_TELEMETRY` | `1`, `0`, `true`, `false`, `log` | Turn telemetry on or off, or print events instead of sending them |
| `CODEX_SANDBOX_NETWORK_DISABLED` | Set, non-empty, and not `0` or `false` | Turn telemetry off, unless `<PREFIX>_TELEMETRY=log` |
| `NO_COLOR`, `FORCE_COLOR`, `TERM` | Standard | Color in human mode |

`<PREFIX>` is `envPrefix`, or the CLI name by default, upper-cased with each run of other characters replaced by `_`. For example, `acme` becomes `ACME`. It names only these four variables: globals and command `env` mappings use the names they declare.

## API reference

Everything below is exported from `clipact`, unless it is marked `clipact/testing`.

### `defineCli(options): Cli`

Creates a CLI from its command tree.

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Binary name, used in help, messages, and `next` commands. |
| `version` | `string` | Printed by `--version` and `schema --list`. |
| `description` | `string?` | Shown in root help. |
| `envPrefix` | `string?` | Prefix of framework variables. Defaults to the name. |
| `globals` | `Globals?` | CLI-wide settings read only from the environment, created by [`defineGlobals`](#defineglobalsoptions-globals). |
| `commands` | `CommandNode[]` | Top-level commands and groups. |
| `skills` | `URL \| string`? | Directory of bundled skills (`<name>/SKILL.md`). Adds the [`skills` commands](#agent-skills). |
| `mapError` | `() => Promise<{ default: MapError }>`? | Lazily imports the error translation hook. |
| `errors` | `ErrorRegistry?` | Every error code the commands return besides the built-in codes, as `{ [code]: { description, details? } }`, where `details` is a `Schema`. See [Errors](#errors). |
| `telemetry` | `{ sender: URL \| string, default?: 'on' \| 'off', docs?: string }`? | Sends usage events through the `sender` module and adds the [`telemetry` commands](#telemetry). |
| `store` | `Store?` | The CLI's store, created by [`defineStore`](#definestoreoptions-store). |

The returned `Cli` has these members:

| Member | Description |
| --- | --- |
| `run(argv = process.argv): Promise<void>` | Runs with the real process. It installs signal, EPIPE, and crash handlers, sets `process.exitCode`, and re-raises an interrupting signal. It drops the first two `argv` entries. |
| `execute(args, io, options?): Promise<Outcome>` | Runs one invocation against injected streams without touching the process. `args` excludes `node` and the script. `invoke` uses it. |
| `options` | The `CliOptions` given to `defineCli`, with the built-in `skills`, `telemetry`, `schema`, and `completion` commands appended to `commands`. |
| `root` | The root group of the command tree, including the built-in commands. |
| `envPrefix` | The resolved prefix, such as `ACME`. |
| `errors` | The full error registry: the built-in codes and the CLI's `errors`. |

`ExecuteOptions` has four optional fields. `signal` interrupts the command when it is aborted with a signal name, such as `'SIGTERM'`, as the reason. `crash` is a promise that rejects with an uncaught error. `strict` turns on the contract checks. `telemetry` receives each telemetry event instead of the sender.

`Outcome` is `{ exitCode: 0 | 1, result, signal }`. `result` is the result object, or `undefined` for help and version. `signal` is the signal to re-raise.

`Io` is `{ env, stdin, stdout, stderr }`. An output stream needs only `write(chunk, callback)` and an optional `isTTY`.

### `defineCommand(options): Command`

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | One word. The command's path is the group names plus this name. |
| `description` | `string` | One line, used in help and `schema --list`. |
| `examples` | `string[]?` | Runnable command lines, shown first in agent help. |
| `input` | `Schema?` | Object schema for all input. Without it, the command takes no input. |
| `positionals` | `Field[]?` | Input fields that may be positional, in order. |
| `env` | `{ [field]?: string }?` | Environment variables used as fallbacks. |
| `secrets` | `Field[]?` | Fields read only from their `env` variable. |
| `output` | `Schema?` | Schema of `data`, an object or an array. It types `ctx.ok()` and appears in `schema`. |
| `errors` | `string[]?` | Codes from the CLI's `errors` registry that the command can return, besides the built-in codes. |
| `readOnly` | `boolean?` | Changes no state. Implies `idempotent`. |
| `idempotent` | `boolean?` | Safe to repeat with the same input. |
| `confirm` | `string \| (input) => string \| undefined`? | Confirmation reason. |
| `dryRun` | `boolean?` | Supports `--dry-run`. |
| `human` | `(data) => string`? | Human-mode formatter for success data. |
| `handler` | `() => Promise<unknown>` | Imports the module whose default export is a `defineHandler` result. |

`Schema` is `StandardSchemaV1 & StandardJSONSchemaV1`. Any library that validates and exports JSON Schema through [Standard JSON Schema](https://standardschema.dev/json-schema) works, such as zod 4 (`import * as z from 'zod'`). TypeScript checks field names, `env` keys, and `secrets` against the input schema.

`defineCommand` throws a `TypeError` for `readOnly` with `confirm` and for a secret without an `env` mapping. clipact runs field-level checks when the command is first resolved, and `assertDefinitions` runs them in tests.

### `defineGroup({ name, description, commands }): Group`

Groups commands under a word, such as `artifacts` in `acme artifacts put`. Groups nest.

### `defineHandler(command, run): Handler`

Pairs a handler with its definition for typing. Default-export the result from the module that the command's `handler` imports. `run(ctx)` may be async, and it must return `ctx.ok(...)` or throw.

`Context` has these members:

| Member | Description |
| --- | --- |
| `input` | Validated input with defaults and transforms applied (`ParsedOf<input>`). |
| `signal` | `AbortSignal` aborted on the first SIGINT, SIGTERM, or SIGHUP, or after a crash. |
| `mode` | `{ format: 'json' \| 'human', agent: string \| false, interactive: boolean }`. |
| `dryRun` | `true` when `--dry-run` was given. |
| `progress({ phase, message, data? })` | Reports progress on stderr. See [Long-running work and signals](#long-running-work-and-signals). |
| `log(message)` | Writes a line to stderr in any mode. |
| `checkpoint({ id, next? })` | Prints the job ID now and uses `next` if the command is interrupted. |
| `telemetry()` | Resolves `{ enabled, optedOut, source, variable? }`. See [Telemetry](#telemetry). |
| `dir({ create? }?)` | Resolves the CLI's folder, creating it unless `create` is `false`. See [Storage](#storage). |
| `ok(data, { next? }?)` | Creates the success result. `output` types `data`. Without an output schema, `data` is optional and defaults to `{}`. |

### `defineGlobals(options): Globals`

Defines the CLI's [globals](#globals).

| Option | Type | Description |
| --- | --- | --- |
| `input` | `Schema` | One object schema for every global. |
| `env` | `{ [field]: string }` | The variable of every field, such as `{ apiUrl: 'ACME_API_URL' }`. TypeScript requires a name for each field. |
| `secrets` | `Field[]?` | Fields redacted in `--debug` output and `schema` defaults. |

`defineGlobals` throws a `TypeError` for a secret without an `env` mapping. It checks the other field rules when the globals are first read or described, and `assertDefinitions` checks them in tests.

The returned `Globals` has `get(ctx)`, which returns the validated values (`ParsedOf<input>`) for a handler's context.

### `defineStore(options): Store`

Defines the CLI's [store](#storage).

| Option | Type | Description |
| --- | --- | --- |
| `schema` | `StandardSchemaV1` | A schema for the whole file, such as a zod object. It needs no JSON Schema. |
| `defaults` | `object?` | Values for top-level keys missing from the file. Required when the schema has a required field without a default. |
| `name` | `string?` | The file name without `.json`. Defaults to `config`. `clipact` is reserved in any case. |

The returned `Store` has `get(ctx)`, which resolves an iso-conf `Conf` for a handler's context. See the [iso-conf API](https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf#usage) for `get`, `set`, `update`, and the rest.

### `CliError`

```ts
new CliError({ code, message, retryable?, retryAfterSeconds?, details?, next?, cause? })
```

| Option | Description |
| --- | --- |
| `code` | Stable `snake_case` code. |
| `message` | One actionable sentence. |
| `retryable` | Overrides the default from the [errors table](#errors). |
| `retryAfterSeconds` | Delay before retrying. |
| `details` | Structured context, such as a list of issues. Its shape follows the registry's schema for the code. |
| `next` | Follow-up steps. |
| `cause` | The underlying error. It is not rendered. |

`isCliError(value)` also recognizes `CliError` instances from another copy of the module.

### Other exports

| Export | Description |
| --- | --- |
| `detectAgent(env): string \| false` | The agent detection that modes use. |
| `BUILTIN_ERRORS`, `BUILTIN_ERROR_CODES` | The built-in codes with their definitions, and the list of their names. Help and `schema` append them to every command's `errors`. |
| `ErrorDefinition`, `ErrorRegistry` | `{ description, details? }`, and a map from code to definition. |
| `ResultObject`, `DataResult`, `ErrorResult` | `{ data, next? } \| { error, next? }`, the result written to stdout. |
| `MapError` | `(error: unknown) => CliError \| undefined \| Promise<…>`. |
| `Next` | `{ by: 'agent' \| 'user', description, command? }`. |
| `ErrorBody` | `{ code, message, retryable, retryAfterSeconds?, details? }`. |
| `InputIssue` | `{ path, message, source?, expected? }`, the items of `invalid_input` details. `expected` lists the accepted values: a group's commands or an enum's members. |
| `InputOf<S>`, `ParsedOf<S>`, `DataOf<S>` | Input before parsing, input after parsing, and handler data for a schema. |
| `TelemetryEvent`, `TelemetryEnv`, `TelemetrySender`, `TelemetryOptions`, `TelemetryStatus` | The event, its `env` block, the sender module's default export, the `telemetry` option, and the status. See [Telemetry](#telemetry). |
| `Command`, `AnyCommand`, `Group`, `CommandNode`, `CommandOptions`, `CliOptions`, `Context`, `Handler`, `Ok`, `Mode`, `ProgressEvent`, `Checkpoint`, `Globals`, `GlobalsOptions`, `AnyGlobals`, `Store`, `StoreOptions`, `AnyStore`, `Schema`, `Io`, `OutputStream`, `Env`, `Outcome`, `ExecuteOptions` | Types used above. |

## Testing API

`clipact/testing` works with the Node test runner and any assertion library.

| Export | Description |
| --- | --- |
| `invoke(cli, args, options?)` | Runs in process with captured streams. Options are `env` (empty by default, so the runner's agent variables do not leak in), `stdin` (text or a stream), `tty`, `signal`, and `strict` (default `true`). Framework variables, command `env` fallbacks, and globals all come from `env`. `process.env` is never read. Returns `RunResult & { outcome, telemetry }`, where `telemetry` lists the events the run would have sent. It never starts the sender. |
| `exec(bin, args, options?)` | Spawns `node <bin> …` without a TTY and with only `PATH` and `DO_NOT_TRACK=1` set, so tests send no telemetry. Options are `env`, `stdin`, `keepStdinOpen`, `kill: { signal, when?, afterMs? }`, and `timeoutMs`. `kill` sends the signal once stderr contains `when`, or after `afterMs`. |
| `assertContract(result)` | Checks the output contract and returns the parsed result. stdout must be exactly one compact JSON object that matches the envelope schema, with `data` or `error` as its first key and no other keys besides `next`. The exit code must be `0` with `data` and `1` with `error`. stdout must have no ANSI codes, and stderr must have no JSON. |
| `assertDefinitions(cli)` | Resolves every command and the globals, and fails with all definition errors at once. These include error codes missing from the registry, output schemas that are not an object or an array, schemas that cannot be converted to JSON Schema, a global without an `env` name, a global that uses a framework variable, and a command `env` variable that is also a global or a framework variable. It does not import handlers. |
| `schemas(cli)` | Every command's `schema` output keyed by path, for snapshot tests. |
| `globalsSchema(cli)` | The `globals` block of `schema --list`, or `undefined` without globals, for snapshot tests. |

`RunResult` is `{ exitCode, signal, stdout, stderr, json }`. `exitCode` is `null` when a signal ended the run.

`invoke` uses strict mode by default. Strict mode turns these contract violations into `internal_error` results, so tests fail with a clear message:

- `data` that is not an object or an array
- `data` that does not match the `output` schema
- an error code that is neither in the command's `errors` nor a built-in code
- `details` that do not match the registry's schema for the code
- `retryable: true` from a command that is neither `readOnly` nor `idempotent`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertContract, assertDefinitions, exec, invoke } from 'clipact/testing'
import { cli } from '../src/main.ts'

test('definitions are valid', () => assertDefinitions(cli))

test('put publishes a file', async () => {
  const result = await invoke(cli, ['artifacts', 'put', 'a.txt'], { env: { ACME_PRIVATE_KEY: 'k' } })
  assert.ok('data' in assertContract(result))
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

These numbers are time over `node -e ''`, measured on Node.js v26.10.0 with a warm compile cache. The CLI has two commands, uses zod, and is bundled with esbuild (`--bundle --splitting --format=esm`), with handlers as separate chunks.

| Path | Measured | Budget |
| --- | --- | --- |
| Import the framework | +6 ms | |
| `--version` | +9 ms | ≤ 10 ms |
| `--help` | +8 ms | ≤ 20 ms |
| `schema <command>` | +10 ms | ≤ 20 ms |
| A command, excluding its own dependencies | +14 ms | ≤ 25 ms |

Unbundled, the same CLI costs 27 to 33 ms, mostly from loading zod's modules. To stay within budget, bundle for release and keep SDK imports in handlers. Import zod as `import * as z from 'zod'`, because `import { z } from 'zod'` pulls in every locale.

## Not yet implemented

The [design milestones](../../docs/agent-cli/framework-design.md#milestones) still include a startup-budget check in CI and NDJSON `--events`. Prompts beyond confirmation, output formats other than JSON and text, and MCP are out of scope.

## Development

Run the type check, the tests, and Biome:

```sh
pnpm --filter clipact check
```

The tests in `test/` run a fixture CLI from `test/fixtures`, both in process and as a real process. They cover results, validation, secrets, `--input`, confirmation, errors, modes, discovery, storage, signals, and crashes.
