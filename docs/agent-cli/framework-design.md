# CLI framework design

Date: 2026-10-01.

`clipact` is a small Node.js library that implements the [CLI guidelines for agents](guidelines.md) once. Any agent-facing CLI built on it gets the output contract, agent behavior, and startup performance by default.

This doc explains why clipact works the way it does. The [clipact README](../../packages/clipact/README.md) is the reference for every option, flag, error code, and testing helper.

The core (milestone 1), shell completions, skills, and telemetry are implemented in [`packages/clipact`](../../packages/clipact/README.md). The startup check is planned, and this doc marks it **(planned)**.

## Goals

- The framework applies every guideline by default, so no command has to. That covers one JSON result on stdout, human diagnostics on stderr, exit codes `0` and `1`, structured errors with `retryable` and `next`, agent detection, offline `schema`, no prompts without a human, and signal and exit hygiene.
- One command definition drives parsing, validation, help, JSON Schema, and types.
- Metadata commands (`--help`, `--version`, `schema`) never import handlers or SDKs.
- The library stays at about 3,000 lines with at most two runtime dependencies, so one team can maintain it. Today `src/` is 5,118 lines (`wc -l packages/clipact/src/*.ts`) with one runtime dependency, `@standard-schema/spec`.

## Non-goals

- Output formats other than JSON and human text (no YAML, TOON, or Markdown).
- MCP servers or adapters, OpenAPI mounting, standalone binaries, and self-update.
- Interactive UI beyond a yes or no confirmation.
- Generating skills from help text. Skills are hand-written and shipped in the package.

## Implementation choices

| Area | Choice | Reason |
| --- | --- | --- |
| Argument parsing | `node:util` `parseArgs` with `tokens: true`, plus our own router | The framework already owns metadata, help, validation, and errors. A parser library would add a second parameter model. Measured cost is near zero (see [Parser libraries](#parser-libraries)). |
| Schemas | Accept any `StandardSchemaV1 & StandardJSONSchemaV1`. Document zod v4 as the default. | One interface gives library-neutral validation and JSON Schema 2020-12 export ([Standard JSON Schema](https://standardschema.dev/json-schema)). zod supports both natively, gives the best error detail, and is what agents write fluently. |
| Handlers | Lazy `import()` per command | Metadata commands never load handler code or SDKs. |
| Output | JSON envelope or human text, nothing else | The guidelines define this contract. |
| Exit | `process.exitCode` only. Signals are re-raised. | Avoids truncated pipes and preserves `128 + N`. |
| Colors | `util.styleText` | No dependency. Respects `NO_COLOR` and `FORCE_COLOR`. |
| Prompts | `node:readline/promises`, gated | No dependency. Prompts appear only when a human is present. |

## Architecture

```text
bin/acme.js            entry shim: enableCompileCache, then import('../dist/main.js')
dist/main.js           defineCli({...}).run(process.argv)  ← manifest only (definitions + schemas)
  ├─ runtime           route → parse → validate → gate → handler → render → exit
  ├─ built-ins         --help, --version, schema, completion, skills, telemetry
  └─ handlers          import('./commands/artifacts/put.run.js') only when that command runs
```

Command definitions import only the schema library and strings. Handlers import SDKs. The runtime imports a handler only when that command runs.

## Defining commands

A command is two modules. The definition declares everything the framework needs to parse, validate, document, and gate the command, and imports only the schema library. The handler does the work and imports SDKs. The example uses a placeholder publishing CLI, `acme`. Its command names and error codes are illustrative, not part of the framework.

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
  errors: ['insufficient_funds', 'storage_partial', 'publication_pending'], // codes from the CLI's registry
  confirm: (input) => `Commits storage funds for ${input.copies} copies.`,
  dryRun: true,
  handler: () => import('./put.run.js'),
})
```

The handler, the `defineCli` call, and the `mapError` hook are in the README's [Quick start](../../packages/clipact/README.md#quick-start). The [launchpad example](../../examples/launchpad/README.md) is a complete CLI that uses every feature.

### No middleware

There is no middleware system. The framework owns the cross-cutting concerns as pipeline steps: validation, confirmation, errors, output, telemetry, and signals. Shared setup is a plain application function that the handler calls, such as `const client = await getClient(ctx.input, ctx.signal)` to create an SDK client from `network` and `privateKey`. TypeScript types that function without framework generics, and the control flow stays visible.

### One input schema

`input` is one object schema for everything the command accepts. The same schema serves validation, `schema`, `--input`, and help, so errors and help use field names instead of tuple indexes. `positionals` lists, in order, the fields that may also be given as positional arguments. Every field is also a flag in kebab case, so `privateKey` becomes `--private-key`. Positionals are shorthand for people at a shell, and agents can name every field.

`defineCommand` checks field-level rules when a command is first resolved, so startup never converts every schema to JSON Schema. In tests, `assertDefinitions` runs the same checks for all commands. The README's [Input](../../packages/clipact/README.md#input) section lists the rules and the precedence of each source.

### Environment variables and secrets

`env` maps input fields to environment variables. A variable fills a field that neither the command line nor `--input` gives. Because an environment value is a fallback and not an explicit source, it never triggers the `--input` overlap error.

Fields listed in `secrets` come only from the environment. A value passed as a flag appears in process listings, shell history, and agent transcripts, and a value in an environment variable does not. The framework also redacts secrets in errors, `--debug` output, telemetry, and `schema` defaults.

The mapping lives in the definition, not in schema metadata, so it works with any Standard Schema library. There are no CLI-wide settings, global flags, or profile files. Declare a value that every command needs, with its `env` mapping, in each command's `input`. A shared schema fragment avoids repeating it, such as `account` in [`fil`'s shared inputs](https://github.com/hugomrdias/fil/blob/main/packages/fil-cli/src/commands/shared.ts).

### Side effects

Three optional properties describe a command's side effects: `readOnly`, `idempotent`, and `confirm`. They follow the safe and idempotent method semantics of HTTP, so they describe what a command does to state and not why that matters. The application gives the reason in `confirm`, such as "Commits storage funds for 2 copies." The framework needs only enough to decide two things: whether to ask before the command runs, and whether a transient error is safe to retry. Help and `schema` show all three properties, so an agent knows before it calls the command.

The framework does not retry commands or requests. Handlers and their SDKs own request-level retries and backoff.

The README's [Side effects and confirmation](../../packages/clipact/README.md#side-effects-and-confirmation) lists the properties and how the gate behaves.

## Execution pipeline

1. **Install process handlers** before anything else:
   - an EPIPE handler on stdout;
   - `process.once` for SIGINT, SIGTERM, and SIGHUP, all feeding one `AbortController`;
   - `uncaughtException` and `unhandledRejection` handlers that convert to `internal_error`.
2. **Resolve the mode.** The inputs are flags (`--json`, `--format human`), `ACME_OUTPUT`, agent detection (`--agent`, `--no-agent`, `ACME_AGENT`, and vendor variables), and TTYs. The mode decides output, prompts, color, help style, and progress. Framework variables such as `ACME_OUTPUT` and `ACME_AGENT` accept fixed values, and an invalid value is `invalid_input` naming the variable. `--help`, `--version`, and `schema` ignore invalid values so discovery always works.
3. **Route** leading positional tokens through the command tree. An unknown command is `invalid_input` with the closest match and a `next` step for `--help`. The root or a group without a subcommand is `invalid_input` in every mode, so agent detection never changes the exit code. Human mode prints the group's help with the error on stderr. In both cases, the `command` issue lists the group's commands in `expected`, and a `next` step points to `acme schema <group>`, or to `acme schema --list` at the root. `acme schema <path>` reports an unknown path the same way, from the deepest group the path matched.
4. **Take the fast paths.** `--version`, `--help`, and `schema` render from definitions and exit without loading a handler.
5. **Parse** with `parseArgs({ strict: false, tokens: true, allowNegative: true })`. The options come from the input's JSON Schema, minus the positional fields: `boolean` becomes a boolean flag, an array becomes `multiple`, and everything else is a string. Positional tokens fill the `positionals` fields in order, and any remainder goes to a final array field. The framework finds unknown options and extra positionals in the tokens, so it reports every problem at once, by name.
6. **Merge and validate.**
   1. Convert string values to their JSON Schema type (number, integer).
   2. Merge with `--input <file|->` JSON. A field given both on the command line and in `--input` is an `invalid_input` error that lists the fields. Framework flags (`--json`, `--yes`, `--dry-run`, `--agent`) are never part of the input. Only one source may read stdin, so `--input -` together with a `-` positional is also `invalid_input`.
   3. Fill fields that are still missing from their `env` variables. The framework reads only the variables of the command being run and converts them like flag values.
   4. Validate the merged object with `~standard.validate`, which applies schema defaults. All issues become one `invalid_input` error with `details: [{ path, source, message, expected? }]`. `source` is `flag`, `positional`, `input`, `env:ACME_NETWORK`, or `default`. When the value is not a member of the field's `enum`, `expected` lists the members, read from the field's JSON Schema so it works with any schema library.
7. **Gate** a command whose `confirm` returns a reason for this input. When a human is present, prompt. Otherwise, require `--yes` or return `confirmation_required` with `details: { reason }` and a `by: "user"` step. Agent detection never relaxes the gate. For a command that declares `dryRun`, `--dry-run` sets `ctx.dryRun` and skips the gate.
8. **Load and run** the handler with `ctx`: typed `input`, `signal`, `mode`, `dryRun`, `progress()`, `log()` (stderr), `checkpoint()`, `telemetry()`, and `ok()`.
9. **Normalize** the outcome:
   - A returned `ok()` becomes `{ data, next? }`.
   - A `CliError` becomes `{ error, next? }`.
   - An abort becomes `interrupted`, with the `next` steps from the latest checkpoint.
   - Any other thrown value goes to the lazily loaded `mapError` hook, if configured. It becomes the returned `CliError`, or `internal_error` when the hook returns `undefined`. The stack appears only with `--debug`.

   In tests, the framework also validates `data` against the output schema, error codes against the command's `errors`, and `details` against the registry's schema for the code.
10. **Render once.** Machine mode writes the single-line JSON in one write. Human mode writes the result to stdout and writes errors, with their `next` steps, to stderr. The framework then sets `process.exitCode`. On interruption, it re-raises the signal after the write callback.
11. **After the result**, print a stale-skill notice in human mode. Then start the detached telemetry sender, except for shell completion, the `telemetry` commands, and interruptions.

## Output and errors

In machine mode, a command writes one JSON object with exactly one of `data` and `error`, then optional `next` steps. The guidelines' [Result envelope](guidelines.md#result-envelope) defines it. [Design decisions](#design-decisions) explains why command output nests under `data` and why there is no `ok` field. The README's [Output contract](../../packages/clipact/README.md#output-contract) lists every key and what goes to each stream.

`CliError` has no `data` option. A failed command returns no `data`, so a result is either a success or a failure and never both. Recovery context goes in `details` and `next`.

### Error registry

The application declares each error code once, in `defineCli({ errors })`, with a description and an optional `details` schema. Commands list the codes they can return by name. `schema <command>` publishes each code with its description and `details` JSON Schema, so an agent learns what a code means before it first sees it. One definition per code also keeps descriptions consistent across commands.

`mapError` is the one hook for errors that the application does not throw itself. It translates SDK errors into registry codes in one module. The framework loads that module only when a handler throws something other than a `CliError`, so startup never imports SDK error classes.

The README's [Errors](../../packages/clipact/README.md#errors) section lists the built-in codes.

### Retryable errors

`retryable` defaults to `false`. When a handler throws a transient code without setting `retryable`, the framework sets it to `true` for `readOnly` or `idempotent` commands and leaves it `false` otherwise. Repeating a non-idempotent command may repeat its side effects, so give its transient errors a `next` step that inspects or resumes the work instead. The testing helpers flag `retryable: true` on a command that is neither `readOnly` nor `idempotent`.

## Modes, agent detection, and help

Agent detection reads `AI_AGENT`, `AGENT`, and a table of vendor variables, and splits a `<name>_<version>_agent` value, such as Claude Code's `claude-code_2-1-299_agent`, into the name and the version. `--agent`, `--no-agent`, and `ACME_AGENT` override it. The framework keeps its own table instead of depending on `std-env` or `@vercel/detect-agent`, because the startup cost of those packages is not measured yet. Detection changes presentation only. It never relaxes the confirmation gate or changes exit codes or the JSON shape.

Help has two styles, both rendered from the definitions. Human help starts with the description and usage. Agent help starts with examples, then lists flags, output fields, and error codes, and points to `acme schema <command>`. On a usage error, an agent gets the command's full help on stderr before the JSON result, so `error.details` stays a list of issues. A human gets the usage line.

The README's [Modes and agent detection](../../packages/clipact/README.md#modes-and-agent-detection) and [Help and discovery](../../packages/clipact/README.md#help-and-discovery) sections list the variables, the order that picks the mode, and what each help command prints.

## Runtime services

- **Signals and exit.** The framework implements [Signal handling](guidelines.md#signal-handling) and [Exit and stream hygiene](guidelines.md#exit-and-stream-hygiene) from the guidelines. `ctx.checkpoint({ id, next })` prints a long-running job's ID to stderr as soon as the handler registers it, so the ID survives a SIGKILL that leaves no time to write a result.
- **Progress.** `ctx.progress()` takes structured `{ phase, message, data? }` objects, not strings. A later NDJSON `--events` mode can emit the same objects without handler changes.
- **Volume and liveness.** Handlers own volume: they report each change once, not every chunk or poll, and clipact prints every event. clipact owns liveness: after 15 seconds without output it repeats the latest event with its elapsed time, then every 30 seconds, as the guidelines ask for [long-running commands](guidelines.md#output-size-and-long-running-commands). An earlier throttle dropped repeated events within 15 seconds. It dropped new information, such as a wait that started right after a signature, and left long waits silent unless each handler re-emitted on a timer.
- **Skills.** The `skills` commands are ordinary framework-defined commands, so help, `schema`, completions, `--dry-run`, and the output contract apply unchanged. `skills install` refuses to replace a copy that the user edited or that another tool wrote, unless the user passes `--force`. The flag that selects directories is `--target agents|claude`, because `--agent` is already the framework's agent-mode flag. The README's [Agent skills](../../packages/clipact/README.md#agent-skills) section describes the commands and the manifest.
- **Framework state.** A `state.json` file in a directory named after the CLI, not after clipact, so each CLI keeps its own telemetry choice. The directory is `$XDG_STATE_HOME/acme` (default `~/.local/state/acme`) on Linux, `~/Library/Application Support/acme` on macOS, and `%LOCALAPPDATA%\acme` on Windows. The file holds the telemetry choice, whether the telemetry notice was shown, and the installation ID, and nothing else. It is not a configuration layer for command input. When the file cannot be read or written, as in sandboxes that block writes to the home directory, the framework treats it as empty and reports nothing.
- **Telemetry.** An application turns telemetry on with `defineCli({ telemetry: { sender } })`. Without it, the framework adds no `telemetry` commands and builds no events. The framework follows the guidelines' [Telemetry](guidelines.md#telemetry) rules, and [Design decisions](#design-decisions) explains each choice below.
  - **Default.** On, unless the application sets `default: 'off'`. The first run prints the one-line notice to stderr and sends its event in the same run. A saved `telemetry enable` or `disable` counts as having seen the notice.
  - **Opt-out.** `DO_NOT_TRACK`, `ACME_TELEMETRY=0`, and the choice stored by `telemetry disable` each turn telemetry off, and any opt-out wins. `ACME_TELEMETRY=log` prints each event to stderr instead of sending it.
  - **Event.** The CLI's name and version under `cli`, then command path, flag names, error code, timestamp, duration, and the installation ID. Where and how the command ran goes under `env`: Node.js version, OS, architecture, mode, format, CI or deployment provider, and agent name and version. Events carry no agent session ID or hash.
  - **CI.** Events are sent in CI, with mode `ci`.
  - **Sender.** `sender` is a module URL, such as `new URL('./telemetry.js', import.meta.url)`. After the result is written, the framework starts a detached, unref'd child process that imports the module and calls its default export with the event and an `AbortSignal` that fires after 10 seconds, when the child exits. The child's code is an inline `node -e` script, so a bundled CLI needs no extra file from clipact, but the sender module itself must exist as a file. The application owns the endpoint and the request format. Nothing is sent when `CODEX_SANDBOX_NETWORK_DISABLED` is set. With `--debug`, the framework waits for the child and prints its errors to stderr.
  - **IDs.** The installation ID is a `crypto.randomUUID()` stored in the state file. It is `null` when the file cannot be saved, and in CI, where it is neither created nor sent.
  - **Handler access.** `await ctx.telemetry()` returns the same `{ enabled, optedOut, source, variable? }` object as `telemetry status --json`. `enabled` says whether the framework sends events for this run. `optedOut` says whether `DO_NOT_TRACK`, `ACME_TELEMETRY=0`, or `telemetry disable` turned telemetry off. `source` says what decided `enabled`: `env`, `config`, `default`, or `unconfigured`, and `variable` names the environment variable that decided, if any. It reads the state file on the first call only, and the post-result step reuses the answer. `ACME_TELEMETRY=log` reports `enabled: true`. Without a `sender`, `enabled` is `false` with source `unconfigured`, and `optedOut` comes from `DO_NOT_TRACK` and `ACME_TELEMETRY` only, because there is no state file or `telemetry` command. An application checks `optedOut` to honor the opt-out in its own reporting, such as an agent header on API requests. A handler must not change its output, exit code, or `data` based on it. Calling it does not count as showing the notice.

## Testing

`clipact/testing` lets each CLI test the output contract instead of trusting it. `invoke` runs the CLI in process with an empty environment, so the runner's agent variables, such as `CLAUDECODE`, do not change the mode. It also turns on strict checks that a normal run skips: `data` must match the output schema, the command must declare each error code, `details` must match the registry's schema for the code, and only `readOnly` or `idempotent` commands may return `retryable: true`. `exec` spawns the real entry file, so tests can cover signals and exit codes on a real process. `invoke` collects telemetry events instead of starting the sender, and `exec` sets `DO_NOT_TRACK=1` unless the test overrides it, so tests never send events. The README's [Testing API](../../packages/clipact/README.md#testing-api) lists the helpers.

**(Planned)** A startup check that runs `--version` and `schema --list` against the [performance budget](#performance-budget).

## Performance budget

| Path | Budget over `node -e ''` | Loads |
| --- | --- | --- |
| `--version` | ≤ 10 ms | Entry shim and framework core |
| `--help`, `schema` | ≤ 20 ms | Plus definitions and the schema library |
| A command, excluding its own dependencies | ≤ 25 ms | Plus the handler module |

The two-command zod CLI measured in the README's [Performance](../../packages/clipact/README.md#performance) section stays within budget on every path, at 8 to 14 ms over `node -e ''`. Unbundled, the same CLI costs 27 to 33 ms over baseline, mostly from loading zod's modules.

Applications bundle to one ESM file with handlers as separate chunks. If definitions plus zod exceed the budget, a build step can precompute `--help` and `schema` output into a JSON manifest, so metadata commands load neither.

## Parser libraries

Measured on official Node v24.21.0 (baseline `node -e ''` 28.0 ms), median of 20 runs, with the same two-command CLI and lazy handlers:

| Library | Version | Dependencies | `--help` / command | Lazy commands | Exit and output overridable | Structured parse errors |
| --- | --- | --- | --- | --- | --- | --- |
| `node:util` `parseArgs` | Node 24 | 0 | 32.5 / 32.2 ms | Our router | Yes | Error code only (tokens let us build our own) |
| [Stricli](https://github.com/bloomberg/stricli) | 1.3.0 | 0 | 34.5 / 35.7 ms | Native `loader` | Yes. Default exit codes are negative, so `-4` exits with 252. | Typed error classes |
| [Gunshi](https://github.com/kazupon/gunshi) | 0.37.3 | 0 | 37.5 / 37.5 ms | Native `lazy(loader, meta)` | Yes, after disabling a stdout banner and stdout errors | `code` and `values` |
| [Commander](https://github.com/tj/commander.js) | 15.0.0 | 0 | 38.7 / 39.4 ms | In the action | `exitOverride()`, `configureOutput()` | String `code` and message |
| [citty](https://github.com/unjs/citty) | 0.2.2 | 0 | 32.7 / 34.5 ms | Yes | With `runCommand` | Partial. Accepts unknown flags. |
| [Optique](https://github.com/dahlia/optique) | 1.3.2 | 0 | 70.4 / 72.9 ms | In the action | Yes | Typed message parts. Adapters for zod and valibot. |
| [brocli](https://github.com/drizzle-team/brocli) | 0.12.1 | 0 | 33.0 / 34.3 ms | In the action | Always calls `process.exit(1)` | Typed events |
| [incur](https://github.com/wevm/incur) | 0.6.1 | 7 | 81.0 / 78.6 ms | In the action | Yes | `fieldErrors` |

Also measured and rejected:

- yargs: 76 ms and 14 packages.
- cleye and sade: hard-wired `console.error` and `process.exit`.
- cac: single-level commands only.
- clipanion: errors on stdout, and the last release was in 2024.
- cmd-ts: text-only errors.
- clerc: plugins add update checks.

Speed does not decide. `parseArgs`, citty, brocli, Stricli, and Gunshi each add under 10 ms to `node -e ''`. The deciding question is who owns the parameter model. Stricli and Gunshi each define parameters, help, and errors their own way. Using either one means mapping our definitions into theirs, and their errors back into our errors and help. `parseArgs` only tokenizes, which is all the framework needs once definitions, validation, help, and errors are its own.

Stricli is the fallback if routing and completions become a burden. It never exits or writes on its own, loads commands lazily, and exposes typed parse errors.

## Schema libraries

Measured on Node v26.10.0 (Homebrew build, baseline 58.6 ms), an 8-field schema with formats, enums, ranges, optional, array, and nested fields:

| Library | Bundled size (gzip) | Bundled import + define + validate | Standard Schema / JSON Schema | Notes |
| --- | --- | --- | --- | --- |
| zod 4.6.5 (`import * as z`) | 89 KB (26 KB) | 67.6 ms | Native / native | Richest issues (`code`, `path`). `import { z }` pulls all locales (443 KB). |
| zod/mini 4.6.5 | 26 KB (8.5 KB) | 62.4 ms | Native / via `toJSONSchema` | Messages are "Invalid input" without a locale. |
| valibot 1.5.0 | 7.6 KB (2.5 KB) | 60.4 ms | Native / adapter package | Produces the cleanest JSON Schema and is the fastest. |
| arktype 2.2.6 | 152 KB (47 KB) | 146 ms | Native / native | Slowest. Descriptions replace error text. |
| TypeBox 0.34 | 104 KB (25 KB) | 62.6 ms | None / is JSON Schema | The application must register formats. |
| JSON Schema + @cfworker/json-schema | 22 KB (6.2 KB) | 63.6 ms | None / is JSON Schema | No type inference, and error messages are noisy. |

The framework depends only on the Standard Schema interfaces, so applications choose. zod v4 is the documented default for three reasons: its schema objects carry both standard interfaces natively, its issues are the most useful for `error.details`, and bundled it costs about 9 ms over baseline. Valibot is the choice when every millisecond matters. Applications import zod as `import * as z from 'zod'`, because `import { z } from 'zod'` pulls in every locale.

## Alternatives considered

- **incur** covers much of the guidelines: schemas, `--schema`, `--llms`, call-to-action suggestions, `retryable`, skills, and MCP. It also breaks several of them:
  - it prints human errors to stdout;
  - it detects agents only by a non-TTY stdout;
  - it calls `process.exit()` after writing;
  - it has no signal handling;
  - it defaults to TOON with the envelope hidden;
  - it generates skills from help text;
  - it loads 128 modules (about 80 ms), with zod and an MCP server as hard dependencies.

  Its scope (five formats, MCP in three directions, binaries, and updates) is broader than we want to own or depend on.
- **Building on Stricli or Gunshi** is viable. It costs two parameter models and two error mappings, and both libraries are 2 to 5 ms slower than `parseArgs` in the table above.

## Design decisions

| Question | Decision | Reason |
| --- | --- | --- |
| Result envelope | `{ data, next? }` or `{ error, next? }`. Closed, with no `ok` field and no partial `data` on failure. | Nesting avoids collisions with envelope keys and allows arrays. The presence of `data` or `error` is the outcome, so no second field can disagree. Failure context belongs in `error.details`. See the guidelines' [Result envelope](guidelines.md#result-envelope). |
| Error codes | A CLI-level registry of `{ description, details? }`. Commands list codes by name. | Agents learn what a code means and what `details` holds before they first see it. One definition per code keeps descriptions consistent across commands. |
| How commands declare positional arguments | One `input` object schema plus an ordered `positionals` list of field names | One schema serves validation, `schema`, `--input`, and help. Errors and help use names instead of tuple indexes. Positionals are shell shorthand, and agents use named fields. |
| `--input` JSON versus flags | Merge. A field given in both is `invalid_input`. | `--input` is the request, not a configuration file. Silently dropping either value is worse than failing with the field names. |
| NDJSON `--events` | Deferred. `ctx.progress()` is structured from v1. When it ships, it emits every `progress` event as is and a separate `{ "type": "heartbeat", "phase", "elapsedMs" }` event on the same schedule as the text heartbeat. | Agents need the final result and an early operation ID, which stderr and `operations` commands already provide. Wrappers can get `--events` later without handler changes. A separate heartbeat type keeps liveness in every mode, because a wrapper's inactivity timeout applies to NDJSON too, and lets consumers tell new information from a repeat. |
| Custom global flags | None in v1. Only framework flags are global. | A value a command needs is part of its `input`. Global options would add a second schema, a second help section, and naming-clash rules. |
| Environment variables | Per-field fallbacks declared with `env` on command input. `secrets` are environment-only and redacted. The framework validates its own variables against fixed values. | Every value a command receives goes through one schema and one validation path, and errors name its source. |
| Profile file | None in v1. `ctx.config` was removed. | Persistent settings come from the user's environment. A file adds location, format, selection, and permission rules without an immediate need. |
| Middleware | None. One optional lazy `mapError` hook. | The framework owns cross-cutting steps, and shared setup is plain typed functions. Middleware that extends `ctx` needs generic plumbing through groups, hides ordering, and adds startup imports. Revisit if several commands repeat logic that functions cannot express. |
| Describing side effects | Generic `readOnly`, `idempotent`, and `confirm` (reason string or function) instead of an `effects` enum | Business categories such as "paid" belong to the application. The framework needs only what drives confirmation and retry classification. |
| Automatic retries | Not implemented in the framework | Handlers and SDKs own I/O and request-level backoff. Re-running a whole handler repeats work, extends the duration the harness sees, and can duplicate side effects. |
| MCP | Not supported | stdio MCP adds no capability over the CLI for agents that can run a shell. Remote MCP needs hosting, OAuth, and an upload design. |
| Shell completions | Dynamic. `completion <shell>` prints a short bash, zsh, or fish script that calls the hidden `__complete` built-in on each Tab. | Candidates come from the same definitions as help, so they are never stale after an upgrade. The logic lives once in TypeScript and is tested with the Node test runner, instead of in three generated shell programs. `__complete` takes the metadata path, so a Tab costs about as much as `--version`. Agents do not use completions. |
| Telemetry default | On when the application configures a sender, with a first-run notice. The first run also sends. Applications can set `default: 'off'`. | Most agent calls run in CI or sandboxes that keep no state, so every run there is a first run. Waiting for the notice before sending, as Homebrew does, would drop nearly all agent events, and agent events are the reason to collect telemetry. On by default with a notice matches Turborepo, Next.js, and gh. |
| Telemetry sender | A module URL that a detached child process imports | A pending in-process request delays exit by up to its timeout, and telemetry must never change how long a command takes. The child needs a path to import, so the option is a URL instead of `() => import()`. |
| Telemetry in CI | Send, with mode `ci` | Agents also run in CI, such as GitHub Actions and cloud agents. The field lets analysis separate CI, agent, and human use. Turborepo, Vercel, Wrangler, and gh do the same. |
| Framework state location | `state.json` in a directory named after the CLI under the platform state directory. Ignored when it cannot be read or written. | Each CLI keeps its own telemetry choice. Sandboxes often block writes to the home directory, and state must never fail a command. |
| Telemetry IDs | A random installation ID stored in state, `null` in CI and when it cannot be saved | A new ID on every unsaved run would inflate install counts. A CI runner's home directory is usually writable but discarded after the job, so every job would save a new ID and count as a new install. `@evlog/telemetry` skips its machine ID in CI for the same reason. |
| CI provider | A `provider` field, such as `github_actions`, from std-env's provider table copied into clipact. No `NODE_ENV`. | The provider separates GitHub Actions, GitLab, and hosted builds, and its values come from a fixed list. std-env works out its values once from `process.env` when it is imported, so `invoke` could not control them, and tests would report the runner's provider. A copied table reads the invocation's environment, like agent detection, and loads only with the telemetry module. `NODE_ENV` is free text in the user's shell, can hold project names, and describes the user's project rather than the CLI. |
| Event timestamp | An ISO 8601 `timestamp` of when the result was written | A sender may batch or retry, so the time the server receives an event is not when the command ran. |
| Agent session grouping | Not sent. Events carry no session ID or hash. | The guidelines suggest a salted session hash to study sequences, such as repeated failing calls or `schema` before a successful call. Every agent uses a different variable, some undocumented and some changed within months, and Gemini CLI and Augment expose none to shells, so the table would need constant checking and still leave gaps. A stable per-session hash also links events into a timeline of one person's session. Most questions, such as error rates by command and agent, need only single events. Revisit if agents agree on a standard variable. |
| Telemetry event fields | No `outcome`, `ci`, `tty`, or agent variable | `errorCode` already says whether the command failed, and mode `ci` says whether `CI` is set. `tty` mostly repeats `format`. The variable that identified an agent helps only to debug detection. |
| Telemetry state in handlers | A lazy `ctx.telemetry()` that returns the `telemetry status` object, with `enabled` and `optedOut` as separate fields. Without a `sender`, `enabled` is `false` and `optedOut` reads only the environment opt-outs. | An application that sends an agent header on API requests, as gh and `cf` do, must say whether the telemetry opt-outs cover it. One `enabled` field would mix two answers: whether clipact sends events, and whether the user opted out. Without a `sender` it would read `true` while nothing is collected, and with `default: 'off'` it would read `false` although the user opted out of nothing. Putting the answer on `ctx` saves the application from passing the name, prefix, and state directory again. A lazy call keeps the state-file read off commands that never ask. The user's `DO_NOT_TRACK` means the same whether or not the application collects events, so it applies without a `sender`. |

## Milestones

1. **Core (implemented).** Definitions, router, `parseArgs` integration, input merging and validation, envelope and errors, modes and agent detection, help, `schema`, signals and exit, and testing helpers.
2. **Spike.** Validate the core on a real CLI, including a long-running, resumable command, and run the guideline tests in Claude Code, Codex, and Gemini CLI. [`fil`](https://github.com/hugomrdias/fil/blob/main/packages/fil-cli/README.md) already runs on clipact, so only the harness runs remain.
3. **Services.** Gating and dry-run polish, and the startup budget in CI. Skills and telemetry are implemented.
4. **Later.** NDJSON `--events`. Shell completions are implemented.
