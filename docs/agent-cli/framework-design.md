# CLI framework design

Date: 2026-10-01. Status: the core (milestone 1) is implemented in [`packages/clipact`](../packages/clipact/README.md), along with shell completions and skills; the other services are not. Name: `clipact`. Scope: a small Node.js library that implements the [CLI guidelines for agents](agent-cli-guidelines.md) once, so `fil` and future CLIs get the output contract, agent behavior, and startup performance by default.

## Goals

- Every guideline is the default behavior, not something each command remembers: one JSON result on stdout, human diagnostics on stderr, exit codes `0`/`1`, structured errors with `retryable` and `next`, agent detection, offline `schema`, no prompts without a human, signal and exit hygiene.
- One command definition drives parsing, validation, help, JSON Schema, and types.
- Metadata commands (`--help`, `--version`, `schema`) never import handlers or SDKs.
- Small enough to own: roughly 3,000 lines and at most two runtime dependencies.

## Non-goals

- Output formats other than JSON and human text (no YAML, TOON, Markdown).
- MCP servers or adapters, OpenAPI mounting, standalone binaries, and self-update.
- Interactive UI beyond a yes/no confirmation.
- Generating skills from help text; skills are hand-written and shipped in the package.

## Decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Argument parsing | `node:util` `parseArgs` with `tokens: true`, plus our own router | The framework already owns metadata, help, validation, and errors; a parser library would add a second parameter model. Measured cost is near zero (see [Parser libraries](#parser-libraries)). |
| Schemas | Accept any `StandardSchemaV1 & StandardJSONSchemaV1`; document zod v4 as the default | Library-neutral validation and JSON Schema 2020-12 export through one interface ([Standard JSON Schema](https://standardschema.dev/json-schema)). zod has native support, the best error detail, and is what agents write fluently. |
| Handlers | Lazy `import()` per command | Keeps metadata commands fast. |
| Output | JSON envelope or human text; nothing else | The guidelines' contract. |
| Exit | `process.exitCode` only; signals re-raised | Avoids truncated pipes; preserves `128 + N`. |
| Colors | `util.styleText` | No dependency; respects `NO_COLOR`/`FORCE_COLOR`. |
| Prompts | `node:readline/promises`, gated | No dependency; only when a human is present. |

## Architecture

```text
bin/acme.js            entry shim: enableCompileCache, then import('../dist/main.js')
dist/main.js           defineCli({...}).run(process.argv)  ← manifest only (definitions + schemas)
  ├─ runtime           route → parse → validate → gate → handler → render → exit
  ├─ built-ins         --help, --version, schema, completion, skills, telemetry
  └─ handlers          import('./commands/artifacts/put.run.js') only when that command runs
```

Command definitions import only the schema library and strings. Handlers import SDKs. The runtime never imports a handler unless that command executes.

## Defining commands

The examples use a placeholder publishing CLI, `acme`; command names and error codes are illustrative, not part of the framework.

```ts
// commands/artifacts/put.ts
import * as z from 'zod'
import { defineCommand } from 'clipact'

/** Publishes a file or folder and returns a shareable link. */
export const put = defineCommand({
  name: 'put',
  description: 'Publish a file or folder and return a shareable link',
  examples: ['acme artifacts put ./report.pdf', 'acme artifacts put ./dist --entry index.html'],
  input: z.strictObject({
    path: z.string().describe('File or folder to publish'),
    entry: z.string().optional().describe('Entry file for folders'),
    copies: z.number().int().min(1).max(5).default(2).describe('Committed copies'),
    network: z.enum(['mainnet', 'calibration']).default('calibration').describe('Target network'),
    privateKey: z.string().describe('Signing key'),
  }),
  positionals: ['path'],
  env: { network: 'ACME_NETWORK', privateKey: 'ACME_PRIVATE_KEY' },
  secrets: ['privateKey'],
  output: z.object({ ref: z.string(), url: z.string().url() }),
  errors: ['insufficient_funds', 'storage_partial', 'publication_pending'],
  confirm: (input) => `Commits storage funds for ${input.copies} copies.`,
  dryRun: true,
  handler: () => import('./put.run.js'),
})
```

```ts
// commands/artifacts/put.run.ts
import { defineHandler, CliError } from 'clipact'
import { put } from './put.js'

export default defineHandler(put, async (ctx) => {
  const { path, copies } = ctx.input // typed from the definition
  ctx.progress({ phase: 'packing', message: `Packing ${path}` }) // stderr; periodic line in agent mode
  const operation = await createOperation(path, copies, { signal: ctx.signal })
  ctx.checkpoint({
    id: operation.id,
    next: [{ by: 'agent', command: `acme operations resume ${operation.id}`, description: 'Resume this operation' }],
  })
  if (!operation.funded) {
    throw new CliError({
      code: 'insufficient_funds',
      message: 'The payer account cannot cover the storage lockup.',
      next: [{ by: 'user', command: 'acme auth fund', description: 'Add funds from an interactive terminal' }],
    })
  }
  return ctx.ok({ ref: operation.ref, url: operation.url })
})
```

```ts
// main.ts
import { defineCli, defineGroup } from 'clipact'
import { put } from './commands/artifacts/put.js'

defineCli({
  name: 'acme',
  version: '1.0.0',
  envPrefix: 'ACME', // names framework variables: ACME_OUTPUT, ACME_AGENT, ACME_TELEMETRY
  commands: [defineGroup({ name: 'artifacts', description: 'Publish and manage artifacts', commands: [put] })],
  aliases: { publish: 'artifacts put' },
  skills: new URL('../skills/', import.meta.url),
  telemetry: { send: () => import('./telemetry.js') },
  mapError: () => import('./map-error.js'),
}).run(process.argv)
```

```ts
// map-error.ts: loaded only when a handler throws something other than a CliError
import { CliError } from 'clipact'
import { InsufficientFundsError } from 'some-sdk'

/** Translates SDK errors into stable CLI error codes. */
export default function mapError(error: unknown): CliError | undefined {
  if (error instanceof InsufficientFundsError) {
    return new CliError({ code: 'insufficient_funds', message: error.shortMessage })
  }
  return undefined // becomes internal_error
}
```

There is no middleware system. Cross-cutting concerns (validation, confirmation, errors, output, telemetry, signals) are pipeline steps the framework owns. Shared setup, such as creating an SDK client from `network` and `privateKey`, is a plain application function the handler calls (`const client = await getClient(ctx.input, ctx.signal)`), which TypeScript types without framework generics and which keeps control flow visible. `mapError` is the single application hook, for translating third-party errors in one place without importing SDKs at startup.

`input` is one object schema for everything the command accepts. `positionals` lists, in order, the input fields that may be given as positional arguments; every field is also a flag in kebab case (`privateKey` → `--private-key`), so agents can name positional fields too. `defineCommand` rejects contradictions immediately. Field checks run when a command is first resolved, so startup never converts every schema; `assertDefinitions` runs them for all commands in tests. They require that each positional names a field of `input`, only the last positional may be an array (a variadic such as `put <paths...>`), optional positionals follow required ones, and no field clashes with a framework flag. An optional `human(data)` property formats successful results for human mode; without it, fields print as `key: value`. Help, validation errors, `--input` JSON, and `schema` all use the field names.

`env` maps input fields to environment variables used as fallbacks when the field is not given on the command line or in `--input`. Precedence is flag, positional, or `--input` → environment variable → schema default. An environment value is a fallback, not an explicit source, so it never triggers the `--input` overlap error. Fields listed in `secrets` must have an `env` mapping and come only from the environment: they get no flag, are rejected in `--input`, and are redacted in errors, `--debug` output, telemetry, and `schema` defaults. The mapping lives in the definition rather than in schema metadata, so it works with any Standard Schema library. There are no CLI-wide settings, global flags, or profile files: a value every command needs is declared, with its `env` mapping, in each command's `input` (a shared schema fragment avoids repetition).

Three optional properties describe a command's side effects in generic terms, following HTTP's safe and idempotent method semantics. The application, not the framework, says why a command is risky.

| Property | Default | Effect |
| --- | --- | --- |
| `readOnly` | `false` | The command changes no state. Implies `idempotent`. |
| `idempotent` | `false` | Repeating the command with the same input has no additional effect. |
| `confirm` | none | A reason string, or a function of the validated input that returns one or `undefined`. When present, the command prompts a human or requires `--yes`. |

`defineCommand` rejects contradictions such as `readOnly` with `confirm`. Help and `schema` show all three, including the confirmation reason, so an agent knows before calling. The framework does not retry commands or requests: handlers and their SDKs own request-level retries and backoff. The properties set the default `retryable` value for transient errors (see [Output and errors](#output-and-errors)).

An alias resolves to the same definition, so help, schema, and telemetry report the canonical path.

## Execution pipeline

1. **Install process handlers** before anything else: EPIPE on stdout, `process.once` for SIGINT/SIGTERM/SIGHUP feeding one `AbortController`, and `uncaughtException`/`unhandledRejection` converted to `internal_error`.
2. **Resolve the mode** from flags (`--json`, `--format human`), `ACME_OUTPUT`, agent detection (`--agent`/`--no-agent`, `ACME_AGENT`, environment variables), and TTYs. The mode decides output, prompts, color, help style, and progress. Framework variables (`ACME_OUTPUT`, `ACME_AGENT`, `ACME_TELEMETRY`) accept fixed values; an invalid value is `invalid_input` naming the variable, except for `--help`, `--version`, and `schema`, which ignore it so discovery always works.
3. **Route** leading positional tokens through the command tree. An unknown command is `invalid_input` with the closest match and a `next` step for `--help`. A group without a subcommand prints its help in human mode and is `invalid_input` listing its commands in machine mode.
4. **Fast paths**: `--version`, `--help`, and `schema` render from definitions and exit without loading a handler.
5. **Parse** with `parseArgs({ strict: false, tokens: true, allowNegative: true })` using options derived from the input's JSON Schema, excluding positional fields (`boolean` → boolean flag, arrays → `multiple`, everything else → string). Positional tokens are assigned to the `positionals` fields in order, with any remainder going to a final array field. Unknown options and extra positionals are detected from the tokens so every problem is reported at once, by name.
6. **Merge and validate**: convert string values to the JSON Schema type (number, integer), then merge with `--input <file|->` JSON. A field supplied both on the command line and in `--input` is an `invalid_input` error listing the fields; framework flags (`--json`, `--yes`, `--dry-run`, `--agent`) are never part of the input. Only one source may read stdin, so `--input -` together with a `-` positional is also `invalid_input`. Fill fields still missing from their `env` variables, reading only the variables of the command being run and converting them like flag values. Validate the merged object with `~standard.validate`, which applies schema defaults. All issues become one `invalid_input` error with `details: [{ path, source, message }]`, where `source` is `flag`, `positional`, `input`, `env:ACME_NETWORK`, or `default`.
7. **Gate** commands whose `confirm` returns a reason for this input: prompt when a human is present, otherwise require `--yes` or return `confirmation_required` with `details: { reason }` and a `by: "user"` step. Agent detection never relaxes this. `--dry-run` sets `ctx.dryRun` for commands that declare support and skips the gate.
8. **Load and run** the handler with `ctx`: typed `input`, `signal`, `mode`, `progress()`, `log()` (stderr), `checkpoint()`, `ok()`.
9. **Normalize**: a returned `ok()` becomes `{ ok: true, ...data, next? }`; a `CliError` becomes its error result; an abort becomes `interrupted` with the `next` steps from the latest checkpoint; any other thrown value is passed to the lazily loaded `mapError` hook, if configured, and becomes the returned `CliError` or otherwise `internal_error` (stack only with `--debug`). In tests, outputs are validated against the output schema and error codes against `errors`.
10. **Render once**: machine mode writes the single-line JSON in one write; human mode writes the result to stdout and errors with `next` steps to stderr. Set `process.exitCode`; on interruption, re-raise the signal after the write callback.
11. **After the result**: lazily load and queue telemetry, and print a stale-skill notice in human mode.

## Output and errors

```ts
/** A follow-up step for the agent or the user. */
type Next = { by: 'agent' | 'user'; description: string; command?: string }

/** Machine-readable error body. */
type ErrorBody = {
  code: string
  message: string
  retryable: boolean
  retryAfterSeconds?: number
  details?: unknown
}

/** The single JSON object written to stdout in machine mode. */
type Result<T extends object> =
  | ({ ok: true; next?: Next[] } & T)
  | ({ ok: false; error: ErrorBody; next?: Next[] } & Partial<T>)
```

`ok`, `error`, and `next` are reserved keys in command output. `CliError` carries the error body and `next`. Built-in codes: `invalid_input`, `confirmation_required`, `interrupted`, `internal_error`, and the transient codes `rate_limited`, `service_unavailable`, and `timeout`. Applications declare the rest per command.

`retryable` defaults to `false`. When a handler throws a transient code without setting `retryable`, the framework sets it to `true` for `readOnly` or `idempotent` commands and leaves it `false` otherwise, because repeating a non-idempotent command may repeat its side effects; those errors should carry a `next` step that inspects or resumes the work instead. The testing helpers flag `retryable: true` on a command that is neither `readOnly` nor `idempotent`.

## Modes, agent detection, and help

Agent detection checks `AI_AGENT`, `AGENT`, then a small table of vendor variables (`CLAUDECODE`, `CODEX_THREAD_ID`, `GEMINI_CLI`, `CURSOR_AGENT`, and others), always overridden by `--agent`/`--no-agent` and `ACME_AGENT`. Keep the table in the framework rather than depending on `std-env` or `@vercel/detect-agent` until their startup cost is measured.

Help is rendered from definitions in two styles:

- **Human**: description, usage, arguments, flags, examples, subcommands.
- **Agent**: examples first, then flags, output fields, error codes, and `acme schema <command>`. On usage errors, agents get the command's full help on stderr before the JSON result, keeping `error.details` a list of issues; humans get the usage line.

## Built-in commands and flags

| Built-in | Purpose |
| --- | --- |
| `--help`, `-h`; `--version` | Metadata from definitions only |
| `--json`, `--format human` | Output mode |
| `--agent`, `--no-agent` | Override detection |
| `--yes`, `--dry-run`, `--input <file\|->` | Gating and input, when the command supports them |
| `--debug` | Stack traces, each input value's source (secrets redacted), and telemetry errors on stderr |
| `schema [command…]`, `schema --list` | JSON Schema for input, output, and errors, with positionals, environment variable names, and secret fields; the command tree |
| `completion bash\|zsh\|fish` | A shell script that asks the hidden `__complete <words…>` built-in for candidates on each Tab |
| `skills install\|status\|uninstall` | Install the bundled skill per the guidelines, when `skills` is configured |
| `telemetry status\|enable\|disable` | Telemetry controls, when `telemetry` is configured |

## Runtime services

- **Signals and exit**: implemented as in [Signal handling](agent-cli-guidelines.md#signal-handling) and [Exit and stream hygiene](agent-cli-guidelines.md#exit-and-stream-hygiene). `ctx.signal` is passed to all handler I/O. `ctx.checkpoint({ id, next })` registers a long-running job: the framework prints the ID to stderr immediately, so it survives a SIGKILL, and includes the `next` steps in an `interrupted` result.
- **Progress**: `ctx.progress({ phase, message, data? })` takes structured objects from the start. It draws a spinner on a human TTY and writes a plain stderr line at most every 15 s in agent mode. A later NDJSON `--events` mode can emit the same objects without handler changes.
- **Framework state**: a small file in the platform state directory holds only framework-owned state: the telemetry choice and whether its notice was shown. It is not a configuration layer for command input.
- **Telemetry**: the framework decides enablement (`DO_NOT_TRACK`, `ACME_TELEMETRY`, the stored choice from `telemetry disable`), builds the event (command path, flag names, outcome, error code, duration, versions, agent, mode), shows the first-run notice, supports `ACME_TELEMETRY=log`, and hands the event to the application's lazily loaded sender after the result is written.
- **Skills** (implemented): copies each `skills/<name>/` directory of the package to `.agents/skills` and `.claude/skills` under the current or home directory, records the CLI version and file hashes in a `.clipact.json` manifest in each copy, and refuses to replace edited or unmanaged copies without `--force`. The commands are ordinary framework-defined commands, so help, `schema`, completions, `--dry-run`, and the output contract apply unchanged. `--target agents|claude` selects directories, because `--agent` is the framework's agent-mode flag.

## Testing

`clipact/testing` exports helpers for the Node test runner:

- `invoke(cli, argv, { env, stdin, tty, signal })` runs in process with captured streams and an empty environment, so the runner's agent variables do not leak in. It enables strict checks: outputs must match the output schema, error codes must be declared, data may not use the envelope keys, and only `readOnly` or `idempotent` commands may return `retryable: true`.
- `exec(bin, argv, { env, stdin, kill })` spawns an entry file without a TTY and with only `PATH` set, optionally sending a signal once stderr shows a given text. Both return `{ stdout, stderr, exitCode, signal, json }`.
- `assertContract(result)`: stdout is exactly one compact JSON object with a boolean `ok`; `exitCode` equals `ok ? 0 : 1`; stdout has no ANSI codes; stderr has no JSON.
- `assertDefinitions(cli)` resolves every command and reports all definition errors; `schemas(cli)` returns every command's `schema` output for snapshot tests.
- Not yet implemented: a startup check that runs `--version` and `schema --list` against a budget relative to `node -e ''`.

## Performance budget

| Path | Budget over `node -e ''` | Loads |
| --- | --- | --- |
| `--version` | ≤ 10 ms | Entry shim and framework core |
| `--help`, `schema` | ≤ 20 ms | Plus definitions and the schema library |
| A command, excluding its own dependencies | ≤ 25 ms | Plus the handler module |

Measured on Homebrew Node v26.10.0 (baseline 59 ms, warm compile cache, median of 20 runs) with a two-command zod CLI bundled by esbuild with handler chunks: importing the framework alone costs 6 ms, `--version` 9 ms, `--help` 8 ms, `schema <command>` 10 ms, and a command 14 ms. Unbundled, the same CLI costs 27–33 ms, mostly from loading zod's modules.

Applications bundle to one ESM file with handlers as separate chunks. If definitions plus zod exceed the budget, a build step can precompute `--help` and `schema` output into a JSON manifest so metadata commands load neither.

## Parser libraries

Measured on official Node v24.21.0 (baseline `node -e ''` 28.0 ms), median of 20 runs, with the same two-command CLI and lazy handlers:

| Library | Version | Dependencies | `--help` / command | Lazy commands | Exit and output overridable | Structured parse errors |
| --- | --- | --- | --- | --- | --- | --- |
| `node:util` `parseArgs` | Node 24 | 0 | 32.5 / 32.2 ms | Our router | Yes | Error code only (tokens let us build our own) |
| [Stricli](https://github.com/bloomberg/stricli) | 1.3.0 | 0 | 34.5 / 35.7 ms | Native `loader` | Yes; default exit codes are negative (`-4` → 252) | Typed error classes |
| [Gunshi](https://github.com/kazupon/gunshi) | 0.37.3 | 0 | 37.5 / 37.5 ms | Native `lazy(loader, meta)` | Yes, after disabling a stdout banner and stdout errors | `code` and `values` |
| [Commander](https://github.com/tj/commander.js) | 15.0.0 | 0 | 38.7 / 39.4 ms | In the action | `exitOverride()`, `configureOutput()` | String `code` and message |
| [citty](https://github.com/unjs/citty) | 0.2.2 | 0 | 32.7 / 34.5 ms | Yes | With `runCommand` | Partial; accepts unknown flags |
| [Optique](https://github.com/dahlia/optique) | 1.3.2 | 0 | 70.4 / 72.9 ms | In the action | Yes | Typed message parts; zod/valibot adapters |
| [brocli](https://github.com/drizzle-team/brocli) | 0.12.1 | 0 | 33.0 / 34.3 ms | In the action | Always calls `process.exit(1)` | Typed events |
| [incur](https://github.com/wevm/incur) | 0.6.1 | 7 | 81.0 / 78.6 ms | In the action | Yes | `fieldErrors` |

Also measured and rejected: yargs (76 ms, 14 packages), cleye and sade (hard-wired `console.error` and `process.exit`), cac (single-level commands), clipanion (errors on stdout, last release 2024), cmd-ts (text-only errors), clerc (plugins add update checks).

All of the fast options cost under 10 ms, so speed does not decide. The deciding question is who owns the parameter model. Stricli and Gunshi each define parameters, help, and errors their own way; using them means mapping our definitions into theirs and theirs back into our errors and help. `parseArgs` only tokenizes, which is all the framework needs once definitions, validation, help, and errors are its own. Stricli is the fallback if routing and completions become a burden: it never exits or writes on its own, loads commands lazily, and exposes typed parse errors.

## Schema libraries

Measured on Node v26.10.0 (Homebrew build, baseline 58.6 ms), an 8-field schema with formats, enums, ranges, optional, array, and nested fields:

| Library | Bundled size (gzip) | Bundled import + define + validate | Standard Schema / JSON Schema | Notes |
| --- | --- | --- | --- | --- |
| zod 4.6.5 (`import * as z`) | 89 KB (26 KB) | 67.6 ms | Native / native | Richest issues (`code`, `path`); `import { z }` pulls all locales (443 KB) |
| zod/mini 4.6.5 | 26 KB (8.5 KB) | 62.4 ms | Native / via `toJSONSchema` | Messages are “Invalid input” without a locale |
| valibot 1.5.0 | 7.6 KB (2.5 KB) | 60.4 ms | Native / adapter package | Cleanest JSON Schema; fastest |
| arktype 2.2.6 | 152 KB (47 KB) | 146 ms | Native / native | Slow; descriptions replace error text |
| TypeBox 0.34 | 104 KB (25 KB) | 62.6 ms | None / is JSON Schema | Formats must be registered |
| JSON Schema + @cfworker/json-schema | 22 KB (6.2 KB) | 63.6 ms | None / is JSON Schema | No type inference; noisy errors |

The framework depends only on the Standard Schema interfaces, so applications choose. zod v4 is the documented default because its schema objects carry both standard interfaces natively, its issues are the most useful for `error.details`, and its cost bundled is about 9 ms over baseline. Valibot is the choice when every millisecond matters. A lint rule bans `import { z } from 'zod'`.

## Alternatives considered

- **incur**: covers much of the guidelines (schemas, `--schema`, `--llms`, call-to-action suggestions, `retryable`, skills, MCP), but prints human errors to stdout, detects agents only by non-TTY stdout, calls `process.exit()` after writing, has no signal handling, defaults to TOON with the envelope hidden, generates skills from help text, and loads 128 modules (about 80 ms) with zod and an MCP server as hard dependencies. Its scope (five formats, MCP in three directions, binaries, updates) is broader than we want to own or depend on.
- **Building on Stricli or Gunshi**: viable, but two parameter models and error mappings for under 5 ms of saving over `parseArgs`.

## Resolved decisions

| Question | Decision | Reason |
| --- | --- | --- |
| How commands declare positional arguments | One `input` object schema plus an ordered `positionals` list of field names | One schema serves validation, `schema`, `--input`, and help; errors and help use names instead of tuple indexes; positionals are shell shorthand, while agents use named fields. |
| `--input` JSON versus flags | Merge; a field given in both is `invalid_input` | `--input` is the request, not a configuration file, so silently dropping either value is worse than failing with the field names. |
| NDJSON `--events` | Deferred; `ctx.progress()` is structured from v1 | Agents need the final result and an early operation ID, which stderr and `operations` commands already provide; wrappers can get `--events` later without handler changes. |
| Custom global flags | None in v1; only framework flags are global | A value a command needs is part of its `input`; global options would add a second schema, help section, and naming-clash rules. |
| Environment variables | Per-field fallbacks declared with `env` on command input; `secrets` are environment-only and redacted; framework variables validated against fixed values | One schema and one validation path for every value a command receives, with the source named in errors. |
| Profile file | None in v1; `ctx.config` removed | Persistent settings come from the user's environment; a file adds location, format, selection, and permission rules without an immediate need. |
| Middleware | None; one optional lazy `mapError` hook | The framework owns cross-cutting steps; shared setup is plain typed functions; middleware that extends `ctx` needs generic plumbing through groups, hides ordering, and adds startup imports. Revisit if several commands repeat logic that functions cannot express. |
| Describing side effects | Generic `readOnly`, `idempotent`, and `confirm` (reason string or function) instead of an `effects` enum | Business categories such as “paid” belong to the application; the framework needs only what drives confirmation and retry classification. |
| Automatic retries | Not implemented in the framework | Handlers and SDKs own I/O and request-level backoff; re-running a whole handler repeats work, extends harness-visible duration, and can duplicate side effects. |
| MCP | Not supported | stdio MCP adds no capability over the CLI for shell-capable agents; remote MCP needs hosting, OAuth, and an upload design. |
| Shell completions | Dynamic: `completion <shell>` prints a short bash, zsh, or fish script that calls the hidden `__complete` built-in on each Tab | Candidates come from the same definitions as help and are never stale after an upgrade; the logic lives once in TypeScript and is tested with the Node test runner instead of three generated shell programs. `__complete` takes the metadata path, so a Tab costs about as much as `--version`. Not used by agents. |

## Milestones

1. **Core** (implemented): definitions, router, `parseArgs` integration, input merging and validation, envelope and errors, modes and agent detection, help, `schema`, signals and exit, testing helpers.
2. **Spike**: build `fil artifacts put` and `fil operations resume` on the core; run the guideline tests in Claude Code, Codex, and Gemini CLI. The prototype, now named `fil`, runs on clipact ([architecture](architecture.md)); the harness runs remain.
3. **Services**: telemetry, gating and dry-run polish, startup budget in CI. Skills are implemented.
4. **Later**: `--events`. Shell completions are implemented.
