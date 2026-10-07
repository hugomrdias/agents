# CLI guidelines for agents

These guidelines cover Node.js command-line tools that coding agents and scripts run through a shell. A coding agent here is Claude Code, Codex, Gemini CLI, Cursor, Copilot, or a similar tool. The program that runs an agent and executes its shell commands is the agent's harness. `acme` is a placeholder executable name.

Research date: 2026-10-01. These are design guidelines. They come from reading the source and documentation of existing CLIs and harnesses, and from local measurements. The evidence labels mean:

- "source": the behavior was read in the named repository.
- "docs": official documentation.
- "measured": a local measurement during this research, on Node v26.10.0 (Homebrew build) and an Apple M1 Pro. Absolute timings vary with hardware and Node build, so compare ratios, not milliseconds.

## Summary

1. **stdout is an API.** In machine mode, every invocation writes exactly one JSON object to stdout, on success and on error. Human-readable diagnostics go to stderr.
2. **Exit `0` or `1`.** Exit `0` when the result has `data`. Exit `1` when it has `error`. The JSON result carries the diagnosis.
3. **Errors say what to do next.** Every error has a stable `code`, a one-sentence `message`, and a `retryable` flag. The result's `next` steps each say whether the agent can run the step or the user must act.
4. **Detect agents to change presentation, never semantics.** A detected agent changes defaults: JSON output, no prompts, no color or spinners, and agent-oriented help. Detection never changes permissions, exit codes, or what a command does.
5. **Discovery works offline.** `acme schema <command>` returns the input and output schemas and the error codes without credentials or network access. The CLI generates them from the same definitions as the parser and help.
6. **Never block on a human.** In agent or noninteractive mode, show no prompts or pagers and launch no browser. A missing input or confirmation is an error with a `next` step.
7. **Keep results small and bounded.** Harnesses truncate output at about 10k tokens or 30k to 40k characters.
8. **Start fast.** Bundle the CLI, lazy-load commands and heavy dependencies, keep SDK imports out of metadata commands, and exit cleanly.

## How agents run commands

Agents read a command's output as text in their context. The harness details below decide which CLI behaviors help and which hurt.

| | Claude Code (Bash tool) | Codex CLI (`exec_command`) | Gemini CLI (`run_shell_command`) |
| --- | --- | --- | --- |
| stdout and stderr | Merged into one stream (docs, probe) | Merged in arrival order ([source](https://github.com/openai/codex/blob/57ac6f5/codex-rs/core/src/unified_exec/process.rs#L369)) | Merged into one `output` string (source: `shellExecutionService.ts`) |
| TTY | None. stdin, stdout, and stderr are not TTYs. | None by default. The model can request one. | **Yes**, a node-pty PTY by default |
| stdin | Immediate EOF | Closed | A PTY. A prompt waits for input. |
| Output limit | About 30,000 characters inline. Longer output becomes a file path plus the first 2,000 characters ([docs](https://code.claude.com/docs/en/tools-reference)). | A 10,000-token budget. Truncates the middle. | Over 40,000 characters, keeps the first 20% and the last 80%, and saves the full output to a file. |
| Timeout | 2 min by default, 10 min at most ([docs](https://code.claude.com/docs/en/env-vars)) | Returns after 10 s by default. The process keeps running in a session that the model can poll. | 300 s without output. New output resets the timer. |
| Kill | Not documented | SIGTERM, a 50 ms grace period, then SIGKILL. On timeout, SIGKILL. | SIGTERM, a 200 ms grace period, then SIGKILL |
| Exit code | Shown. Any nonzero exit is a failure, except from `grep`, `find`, `diff`, `test`, and similar commands. | Shown as `Exit code: N` | Shown when nonzero |
| Environment | `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, and `AI_AGENT` observed | `NO_COLOR=1`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `CODEX_CI=1`, `CODEX_THREAD_ID` | `GEMINI_CLI=1`, `TERM=xterm-256color`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0` |

The Codex and Gemini CLI facts come from the source at [openai/codex@57ac6f5](https://github.com/openai/codex/tree/57ac6f5) and [google-gemini/gemini-cli@c6bccb7](https://github.com/google-gemini/gemini-cli/tree/c6bccb7). The Claude Code facts come from its documentation and a probe of a v2.1.284 session.

The table leads to five design rules:

- **Streams merge.** The model sees stdout and stderr together. Separate streams still matter for scripts and for harnesses that capture each stream on its own. But stderr is not a private channel, and everything written there costs tokens. Do not repeat the JSON error as verbose text on stderr.
- **`isTTY` does not mean a human.** Gemini CLI runs commands in a PTY, so a TTY check alone would turn on prompts, spinners, and color there. Check for an agent as well.
- **Grace periods last tens of milliseconds.** A signal handler cannot save much state before SIGKILL arrives. Persist progress while the command works.
- **Truncation differs by harness.** Some harnesses keep the head, some keep the tail, and some keep both. Only a result that fits within every limit reaches the model intact.
- **Harnesses show the exit code as a bare number.** No harness maps CLI-specific codes to meanings. The model reasons from the number and the output text.

## Output contract

### Streams and modes

| Mode | Selected by | stdout | stderr |
| --- | --- | --- | --- |
| Machine | `--json`, `ACME_OUTPUT=json`, or a detected agent | One JSON object, written once at the end | A short human-readable summary on failure. Progress lines only for long-running work. |
| Human | The default in an interactive terminal. `--format human` overrides a detected agent. | A concise human-readable result | Errors, warnings, progress, and spinners. Spinners appear on a TTY only. |
| Events | `--events` | NDJSON events with sequence numbers, ending with the same result object as machine mode | Same as machine mode |

Follow these rules for streams and modes:

- An explicit flag always wins over environment variables and agent detection. `--json` and `--events` are mutually exclusive.
- In machine mode, stdout contains only the result: no banners, update notices, warnings, ANSI codes, or progress.
- Write the JSON result in a single `write` call, after all stderr output. When the streams merge, no stderr text can then land inside the result.
- Emit compact, single-line JSON followed by a newline. Compact JSON costs fewer tokens than pretty-printed JSON and works with NDJSON tools.
- A command whose output is raw data, such as a binary download to stdout, cannot also write JSON to stdout. Reject the conflicting combination, or require `--output <file>`.
- Respect `NO_COLOR`, `FORCE_COLOR`, and `TERM=dumb`. Turn off color and animation for detected agents even when a PTY is present.

In human mode, errors go to stderr. In machine mode, the error JSON goes to stdout, as in Vercel ([`agent-output.ts`](https://github.com/vercel/vercel/blob/c628be7/packages/cli/src/util/agent-output.ts)), Railway, PlanetScale, Google Workspace CLI, and Supabase's TypeScript rewrite. GitHub CLI and Cloudflare's `cf` write errors to stderr as text only. An agent that runs them must parse prose to tell an auth error from a not-found error.

### Result envelope

The envelope is the set of top-level keys that every machine-mode result shares. It has three keys:

| Key | Meaning |
| --- | --- |
| `data` | The command's output. Present only on success. An object or an array, described by the command's output schema. A command with no output returns `{}`. |
| `error` | The failure. Present only on failure. See [Errors, next steps, and retries](#errors-next-steps-and-retries). |
| `next` | Optional ordered list of recommended follow-up steps, on success or failure. |

```json
{
  "data": { "id": "itm_123", "name": "report", "url": "https://example.com/itm_123" },
  "next": [{ "by": "agent", "command": "acme items get itm_123", "description": "Inspect the item" }]
}
```

Follow these rules for the envelope:

- Every result has exactly one of `data` and `error`. Which one is present is the outcome. Do not add an `ok` or `status` field, because a second field can disagree with the first.
- Keep the envelope closed. Never write other top-level keys. Put command output in `data`, failure context in `error.details`, and warnings and progress on stderr.
- Write `data` or `error` first and `next` last. Harnesses that truncate long output keep its head, so the outcome stays visible.
- A failed command returns no `data`. Put what the agent needs to recover, such as an operation ID or the items still pending, in `error.details` and `next`.
- A command that always returns a complete list can return a bare array in `data`. A paginated command returns an object, such as `{ "items": [], "nextCursor": "c_2" }`. Changing a bare array to an object later breaks callers, so start with an object for any list that can outgrow one page.

A dedicated `data` key keeps command fields from colliding with envelope keys, allows arrays, and lets one JSON Schema describe every result. Most response formats nest the payload: JSON-RPC 2.0 under `result` ([spec](https://www.jsonrpc.org/specification#response_object)), and JSON:API, GraphQL, and the Google JSON Style Guide under `data`. The Firebase CLI ([source](https://github.com/firebase/firebase-tools/blob/7f77472/src/command.ts#L224-L228)) and the Salesforce CLI ([source](https://github.com/salesforcecli/sf-plugins-core/blob/5cdcf02/src/sfCommand.ts#L381-L387)) nest it under `result`. npm merges `error` into flat output, and its source notes that "all json output should be keyed under well known keys, eg `result` and `error`" ([source](https://github.com/npm/cli/blob/b317f16/lib/utils/display.js#L126-L131)).

### Field values

These conventions apply to `data` and to `error.details`:

- Write integers that can exceed 2^53 as decimal strings. Amounts, chain IDs, and byte counts of large stores are examples.
- Include units for quantities.
- Use ISO 8601 timestamps in UTC.
- Prefer meaningful, stable identifiers and names to opaque UUIDs alone.

### Errors, next steps, and retries

```json
{
  "error": {
    "code": "auth_required",
    "message": "No credentials found for profile \"default\".",
    "retryable": false
  },
  "next": [
    { "by": "user", "command": "acme auth login", "description": "Sign in from an interactive terminal, then retry" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `error.code` | A stable `snake_case` identifier from the CLI's error registry. Agents and scripts branch on the code, not on the message. |
| `error.message` | One actionable sentence. No stack traces unless `--debug` is set. |
| `error.retryable` | `true` only if running **the same command again** is safe and might succeed without anyone changing anything. |
| `error.retryAfterSeconds` | Optional delay before a retry, from the `Retry-After` header or local policy. |
| `error.details` | Optional structured context. The registry fixes its shape for each code, such as `[{ "path": "--limit", "message": "must be ≤ 100" }]` for `invalid_input`. |
| `next[].by` | `agent` if the agent can do the step. `user` if a human must act: sign in, approve spending, confirm a deletion, or fix configuration. |
| `next[].command` | Optional exact command line. It must run as written, with real IDs filled in. |
| `next[].description` | What the step does and why. |

A `next` step with `by: "user"` is the **action-required** signal. It tells the agent to stop and relay the step to its user instead of trying workarounds. Vercel models the same idea as `status: "action_required"` with `userActionRequired` ([source](https://github.com/vercel/vercel/blob/c628be7/packages/cli/src/util/agent-output-constants.ts)).

Follow these retry rules:

- Before failing, retry idempotent requests inside the CLI with bounded backoff. Typical cases are reads, rate limits, `5xx` responses, and connection resets. Return `retryable: true` only when the retry budget is spent and a later attempt could still succeed.
- A mutation with an unknown outcome is **not** retryable. A timeout after submission and a crash mid-request are examples. Return `retryable: false` with a `next` step that inspects or resumes the operation, so the agent does not repeat a side effect.
- Make mutations idempotent where possible, with client-generated request IDs or "create if absent" semantics. Otherwise, give each mutation an operation ID that a `resume` or `status` command accepts.
- Validation, authorization, not-found, and policy errors are never retryable.

Declare every error code once, in a registry at the CLI level. The registry gives each code a one-sentence description and, when `details` has a fixed shape, a JSON Schema for `details`. Each command lists the codes it can return, and `acme schema <command>` publishes those codes with their descriptions and `details` schemas. An agent then knows what a code means before it first sees one. RFC 9457 takes the same approach: each problem type has a URI that documents its meaning and its extra members ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html#section-3)).

Common codes are `invalid_input`, `auth_required`, `permission_denied`, `not_found`, `conflict`, `rate_limited`, `service_unavailable`, `timeout`, `confirmation_required`, `interrupted`, and `internal_error`. Add domain-specific codes. Do not use a generic `failed`.

## Exit codes

**Use only `0` and `1`.** Exit `0` when the result has `data`. Exit `1` when it has `error`, including for usage errors, action-required results, and timeouts.

The survey supports this rule for five reasons:

- **Harnesses do not interpret codes.** Codex and Gemini CLI print the number into context. Claude Code treats any nonzero exit as a failure. Only the text that comes with the code explains what happened.
- **Rich taxonomies are rare and inconsistent.** Most CLIs use only `0` and `1`: Stripe, Netlify, Supabase, Neon, kubectl, gcloud, Codex, and `cf`. Where taxonomies exist, they disagree. "Auth required" is `4` in gh, `3` in Pulumi, `2` in Google Workspace CLI, `41` in Gemini CLI, and `253` in AWS CLI. Exit `2` means a usage error in Bash builtins, argparse, cobra, clap, and Vercel. It means cancelled in gh, fatal in PlanetScale, changes present in Terraform (`-detailed-exitcode`), auth in Google Workspace CLI, and incomplete in Filecoin Pin.
- **The JSON result already carries the detail.** An exit code adds a few bits at most, and a second source of truth can disagree with the JSON.
- **Exit `2` has a special meaning in Claude Code hooks.** It blocks the action and feeds stderr to the model ([docs](https://code.claude.com/docs/en/hooks)). A CLI that exits with `2` on usage errors blocks the agent unexpectedly when it runs as a hook.
- **Node exits with `1` on an uncaught exception**, so a crash still reads as a failure.

Scripts branch on the JSON instead, for example with `acme items get itm_123 --json | jq -e 'has("data")'` or `jq -r '.error.code'`.

The CLI chooses only `0` and `1`. The platform produces a few other codes:

- **Signals.** When a signal terminates the process, the shell reports `128 + N`: `130` for SIGINT and `143` for SIGTERM. After a brief cleanup, re-raise the signal instead of exiting with `0` or `1`, so callers and shells see the interruption. See [Signal handling](#signal-handling).
- **Child processes.** A command that runs another program, such as `acme run -- <cmd>`, passes through the child's exit code, as uv, Railway, and `cf` do. Document each such command.
- **Node runtime failures.** Node itself can exit with other codes on internal errors, such as `13` for an unsettled top-level await or an abort on heap exhaustion. Install `uncaughtException` and `unhandledRejection` handlers that emit an `internal_error` result and exit with `1`.
- **Help and version.** `--help` and `--version` exit with `0`. Do not add opt-in exit codes such as Terraform's `-detailed-exitcode`. Add a JSON field instead.

## Agent detection and help

Detect agents from environment variables, in this order:

1. `AI_AGENT`, the generic convention, then `AGENT`. [`@vercel/detect-agent`](https://www.npmjs.com/package/@vercel/detect-agent) promotes `AI_AGENT`, and gh and [`std-env`](https://github.com/unjs/std-env) honor it. Amp and Goose use `AGENT`.
2. Vendor variables, including `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CODEX_THREAD_ID`, `CODEX_CI`, `GEMINI_CLI`, `CURSOR_AGENT`, `OPENCODE`, `AUGMENT_AGENT`, `COPILOT_AGENT_SESSION_ID`, `AMP_CURRENT_THREAD_ID`, and `QWEN_CODE_SESSION_ID`. `cf` keeps a maintained list ([source](https://github.com/cloudflare/cf/blob/45f8332/packages/cli/src/lib/agent-context.ts)).
3. A user override: the `--agent` or `--no-agent` flag, or `ACME_AGENT=1` or `ACME_AGENT=0`.

Prefer a maintained library to a private list. `std-env` exports `isAgent` and `agent`, and `@vercel/detect-agent` is similar. Do not treat `CI` or `TERM` as agent signals. Detection is a heuristic. IDE terminals that a human may use also set `CLAUDECODE=1`. For that reason, detection may change only presentation defaults, and the user must be able to override it.

Detection changes these defaults:

| Behavior | Human default | Agent default |
| --- | --- | --- |
| Output | Human mode | Machine mode |
| Prompts, pagers, browser launch | Allowed on a TTY | Never |
| Color, spinners, animation | On a TTY | Off |
| Usage error | A short usage line | Full help for the attempted command, as gh does ([source](https://github.com/cli/cli/blob/fc4b137/internal/ghcmd/cmd.go#L270-L300)) |
| Help | Narrative | Examples, output fields, and error codes first, with a pointer to `acme schema` |
| Long-running progress | Spinner | A plain progress line on stderr every 15 to 30 s. Each line also resets inactivity timeouts. |

Detection never changes permissions, the confirmations required for destructive or paid actions, exit codes, the JSON schema, or which operation runs. Running under an agent is not authorization.

Write help for agents this way:

- Start with one or two runnable examples. Then list the flags, then the output fields and error codes, then a pointer to `acme schema <command>`.
- Use consistent verbs and flags across commands. `cf` enforces naming in its schema layer: always `get`, never `info`, and always `--force` ([blog](https://blog.cloudflare.com/cf-cli-local-explorer)).

## Discovery and schemas

| Command | Returns |
| --- | --- |
| `acme schema <command…>` | JSON Schema (2020-12) for the command's input and for its `data` (`output`), and the command's error codes with their descriptions and `details` schemas |
| `acme schema --list` or `acme commands --json` | The full command tree with one-line descriptions, and the JSON Schema of the result envelope, in one call |

- Discovery must work without credentials, configuration, or network access, and must not load SDKs. See [Startup performance](#startup-performance).
- Generate the parser, help text, validation, JSON Schemas, and any MCP tool definitions from one command definition. `cf` generates its CLI and docs from one TypeScript schema. Google Workspace CLI exposes `gws schema <method>` at run time ([post](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/)).
- `output` describes only `data`. The envelope is the same for every command, so `schema --list` publishes its schema once instead of repeating it for each command. MCP splits it the same way: a tool's `outputSchema` describes only `structuredContent`, and the protocol defines the rest. An MCP adapter can reuse `output` as `outputSchema` when `data` is an object, because MCP requires an object at the root.
- The schema describes the installed CLI, so the schema version is the CLI version. There is no separate schema version or result version. Agents read the schema from the binary they run. Scripts that depend on output fields pin the CLI version. Removing or renaming fields, error codes, or flags requires a major CLI release.

## Input

- Accept human-friendly flags for simple cases. For complex requests, accept `--input <file.json>`, or `--input -` to read from stdin. Validate both against the same input schema, and document which one wins when a request uses both.
- Do not require shell-escaped JSON for simple values such as file paths.
- Support `-` for stdin and stdout where it makes sense.
- Harden input against model mistakes. Reject control characters, path traversal, query strings or fragments inside IDs, and unknown flags. `util.parseArgs` with `strict: true` rejects unknown flags. Report all invalid fields at once in `error.details`.
- Never accept secrets as flag values. Flag values appear in process listings, shell history, and agent transcripts. Read secrets from environment variables, a credential store, a file, or stdin.

## Noninteractive behavior and safety

- Prompt only when all three conditions hold: stdin and stdout are TTYs, no agent or CI is detected, and `--no-input` is absent. Otherwise, a missing required value is an `invalid_input` error that names the flag to pass.
- When the CLI does not prompt, destructive and paid actions require a confirmation flag. Pick `--yes` or `--force`, and use the same flag in every command. Without the flag, return `confirmation_required`, exit with `1`, and include a `next` step for the user. Never print "Aborted" and exit with `0`. `cf` does that for noninteractive deletes ([source](https://github.com/cloudflare/cf/blob/45f8332/packages/cli/src/lib/prompt.ts#L323-L330)), and agents read it as success.
- Never open a browser, pager, or editor in agent or noninteractive mode. An authentication flow that needs a browser returns `auth_required` with a user step.
- Offer `--dry-run` on mutating commands. A dry run validates, resolves, and estimates cost. It returns what would happen in the same result shape, without side effects.
- Never print secrets, tokens, or private keys, including in errors and debug output. Redact values in echoed configuration.
- Treat data from remote services as untrusted content. Return it in clearly named data fields. Never phrase CLI output so that remote text reads as instructions to the agent.

## Output size and long-running commands

- List commands return a bounded page by default, such as 20 items, with cursor pagination (`nextCursor`) and `--limit`.
- Support `--fields` to select output fields, as gh does with `--json <fields>` ([docs](https://cli.github.com/manual/gh_help_formatting)).
- Keep a typical result well under 10,000 tokens. Write large payloads, such as logs, file contents, and archives, to a file. Return the file's path, size, and digest.
- Keep file bytes, full histories, and verbose traces out of ordinary results. Provide `--verbose` or a separate inspect command for them.
- If a command can outlast harness timeouts, persist an operation record before it starts side effects. Return the operation ID early or on interruption, and offer `status`, `wait`, and `resume` commands. Allow `--no-wait` to return right after submission.
- Persist progress as the command works, not in a signal handler. Harnesses allow 50 to 200 ms before SIGKILL.

## Configuration and environment

- Resolve settings in a documented order: flag, environment variable, profile or configuration file, then default. Show the resolved values and their sources in `acme config --json` or `acme doctor --json`.
- Prefix the CLI's environment variables (`ACME_*`). Respect the standard variables `NO_COLOR`, `FORCE_COLOR`, `CI`, `HTTP_PROXY`, `HTTPS_PROXY`, and `XDG_*`.
- Store state in the platform's application data or state directory. Provide an override variable for CI and ephemeral harnesses.
- Never run blocking update checks in agent, CI, or machine mode, and never write update notices to stdout. See [Telemetry](#telemetry) for usage reporting.

## Telemetry

Most developer CLIs collect usage telemetry by default and let users opt out. Agents now make a large share of invocations. Telemetry tells a CLI team which commands agents call, where agents fail, and which errors they cannot recover from. Telemetry must never change what a command does, what it prints to stdout, its exit code, or how long it takes.

### Opting out

| Control | Behavior |
| --- | --- |
| `DO_NOT_TRACK` | Turns off telemetry when set to any value other than empty, `0`, or `false`. |
| `ACME_TELEMETRY=0` | The product's own opt-out. `ACME_TELEMETRY=log` prints each event to stderr instead of sending it, as `GH_TELEMETRY=log` does. |
| `acme telemetry status\|enable\|disable` | Saves the setting in configuration. `status --json` reports the effective state and the source that decided it: environment, configuration, or default. `cf cli telemetry` does the same. |

Any opt-out wins. If `DO_NOT_TRACK`, `ACME_TELEMETRY`, or the configuration turns telemetry off, the CLI sends nothing, and `ACME_TELEMETRY=1` does not override `DO_NOT_TRACK`. The `telemetry` command itself never reports, so turning telemetry off sends no event. Prisma does the same.

`DO_NOT_TRACK` has no specification. Its original site, consoledonottrack.com, no longer hosts the proposal, so do not link to it. Many CLIs honor the variable, but not all. This table comes from source unless noted:

| Honors `DO_NOT_TRACK` | Own opt-out only |
| --- | --- |
| gh (`GH_TELEMETRY` takes precedence), Turborepo, Wrangler and `cf` (`DO_NOT_TRACK` overrides everything), Nuxt, Supabase, Railway, Stripe CLI, Prisma 8, Bun (crash reports), Claude Code (strings in the compiled binary) | Next.js (`NEXT_TELEMETRY_DISABLED`), Vercel (`VERCEL_TELEMETRY_DISABLED`), Astro, Netlify (flags only), Angular (`NG_CLI_ANALYTICS`), Storybook, Expo, Homebrew (`HOMEBREW_NO_ANALYTICS`), .NET (`DOTNET_CLI_TELEMETRY_OPTOUT`), Gemini CLI and Codex (configuration only) |

Accepted values differ. Supabase and Prisma accept only `1`. Most accept `1` or `true`. Bun and Nuxt accept any truthy value. The `DO_NOT_TRACK` rule above covers all of them.

### Consent and notice

- **Default.** Telemetry on by default, with a notice and an opt-out, is the common choice: Turborepo, Next.js, Vercel, Wrangler, gh, and Homebrew. Nuxt and Angular ask for consent in an interactive terminal and keep telemetry off otherwise. Go chose the most conservative model after public debate. Since Go 1.23, the default mode, `local`, collects counters on disk and uploads nothing unless the user runs `go telemetry on` ([Go telemetry](https://go.dev/doc/telemetry), [rationale](https://research.swtch.com/telemetry-opt-in)). Choose the default on purpose and record why.
- **Notice.** On first run, print a one-line notice with opt-out instructions to stderr, in every mode, and record that the notice was shown. Never print it to stdout. Homebrew sends nothing until it has shown the notice.
- **Documentation.** Publish the list of events and fields. Keep the event schema in the repository so reviewers see changes.

### What to collect

| Collect | Never collect |
| --- | --- |
| Command path and flag **names** | Positional arguments and flag values |
| Outcome: success or `error.code`, duration | Error messages, stack traces with paths, response bodies |
| CLI version, Node version, OS, architecture | File paths, file contents, project or repository names |
| `ci`, `tty`, mode (`interactive`, `noninteractive`, `ci`) | Environment variable values, tokens, account emails |
| Detected agent name | Raw agent session IDs or prompts |
| A random installation ID, generated locally | Hardware identifiers or IP-derived identity |

To group events by project, hash a project identifier with a salt that the CLI generates locally and never sends, as Next.js and Turborepo do. Prisma 8 records only the flags typed on the command line, without their values. Vercel redacts `--project` values.

### Identifying agents

Record the detected agent. Turborepo, Next.js, Vercel, `cf`, Wrangler, gh, Netlify, Supabase, Stripe, Prisma, Storybook, and Railway all do, usually with the same detection as [Agent detection and help](#agent-detection-and-help).

- Record a normalized agent name (`claude-code`, `codex`, `gemini-cli`), its version when available, and the variable that matched, as Netlify does.
- To group the commands of one agent session, send a salted hash of the session ID, never the raw ID. `cf` sends `sha256("cf-agent-session-v1", deviceId, agent, sessionId)` truncated to 32 hex characters.
- Measure what agents need: error codes by command and agent, repeated identical failing calls, `next` steps that agents followed, how often `schema` or `--help` precedes a successful call, and commands that harness timeouts interrupted.
- Agent identity in API requests is a separate decision. gh appends `Agent/<name>` to its `User-Agent`, and `cf` sends `X-CF-CLI-Agent`. Neither CLI's telemetry opt-out covers its header. If you send such a header, document it and state whether the opt-outs apply.

### Sending

- **Never block or fail the command.** Send from a detached, unref'd child process, as Next.js, Vercel, gh, and Prisma do. Or send in-process with a short timeout and an unref'd handle, as `cf` does with `AbortSignal.timeout(1000)`. A pending in-process request delays exit for its full timeout. A detached sender keeps that delay off every command's critical path.
- **Swallow all telemetry errors.** Show them only with `ACME_TELEMETRY=log` or `--debug`.
- **Load telemetry code lazily**, after the CLI writes the command result, so it never adds to startup time. See [Startup performance](#startup-performance).
- **Skip sending without a network.** Skip sending in offline mode and when `CODEX_SANDBOX_NETWORK_DISABLED` is set. Expo turns off telemetry with `EXPO_OFFLINE`. Never retry telemetry uploads in the foreground.
- **Do not send on interruption.** See [Signal handling](#signal-handling). If the event matters, save it locally and send it with a later invocation.
- **Decide CI explicitly.** Netlify and Prisma 8 turn off telemetry in CI. Turborepo, Vercel, Wrangler, and gh send events with a `ci` field. Either way, record `ci` so you can separate agent, CI, and human usage.

## Agent Skills

An [Agent Skill](https://agentskills.io/specification) is a directory with a `SKILL.md` file. The file starts with `name` and `description` frontmatter, followed by instructions. Agents load only the metadata at startup and read the body only when a task matches, so a skill is the cheapest way to teach an agent a CLI's workflow. The [OpenAI](https://developers.openai.com/plugins/concepts/skills) and [Claude Code](https://code.claude.com/docs/en/skills) documentation describe how harnesses load skills.

The specification does not require a location. It recommends that clients scan the project's `.agents/skills` and the user's `~/.agents/skills` as well as their native directory ([client guidance](https://agentskills.io/client-implementation/adding-skills-support)). Codex, Cursor, Gemini CLI, Copilot, OpenCode, Amp, and Cline read the project's `.agents/skills`. Claude Code reads only `.claude/skills` and `~/.claude/skills`. Installers therefore write to both.

### Skill content

- **Teach the workflow, not the reference.** Cover the main tasks and the few rules the model needs: use machine output, branch on `error.code`, relay `by: "user"` steps, and resume a mutation instead of repeating it. Keep the body well under 500 lines.
- **Point to version-matched details.** Flags and fields belong in `acme schema` and `--help`, which always match the installed binary. Turborepo's skill points only to the documentation shipped inside the installed `turbo` package, which "match the installed version exactly". Next.js points `AGENTS.md` to `node_modules/next/dist/docs/`.
- **Ship the skill in the npm package** as `skills/<name>/SKILL.md`, and record the CLI version in the frontmatter `metadata`. Prisma uses this layout, and the `skills` CLI scans for it.
- **Do not depend on the skill for correctness.** The CLI enforces the contract. The skill only makes the first call more likely to succeed.

### A setup command

Provide a setup command that is opt-in and scriptable. Stripe (`stripe agent setup`), Railway (`railway setup agent`, `railway skills`), Nx (`nx configure-ai-agents`), Prisma (`prisma skills sync`), Vercel (`vercel skills`), and Neon (`neon init`, `neon skills`) all have one. Without a setup command, users copy files by hand or pull an unversioned copy from a repository.

| Command | Behavior |
| --- | --- |
| `acme skills install [--target agents\|claude…] [--scope project\|global] [--force]` | Copies the bundled skill to `.agents/skills/acme/` and to `.claude/skills/acme/`, or to the user-level equivalents. Defaults to both targets and project scope. |
| `acme skills status --json` | Reports each installed copy, its recorded CLI version, whether it is stale relative to the running CLI, and whether someone edited it. |
| `acme skills uninstall [--target agents\|claude…] [--scope project\|global]` | Removes only the files that the CLI installed and that nobody has edited. |

Follow these rules for the setup command:

- **Never install as a side effect.** Do not write skills or edit `AGENTS.md` or `CLAUDE.md` from unrelated commands or from `postinstall` scripts. Next.js writes agent files during `next dev`, and Prisma's `init` adds a `postinstall` sync. Both surprise users who did not ask for them. Wrangler's offer after a command is acceptable only because it runs on a TTY, outside CI, and remembers the answer.
- **Follow the output contract.** `-y` and `--json` make the command usable by agents, and an agent may run it when its user asks. Global scope writes to the home directory, so it requires an explicit `--scope global`.
- **Protect user edits.** Keep a manifest of installed file hashes. Skip modified or unmanaged skill directories unless the user passes `--force`. Railway keeps a hash manifest, and Prisma refuses unmanaged directories.
- **Detect staleness.** When the installed skill's version differs from the running CLI, `skills status` reports it. In human mode, a short notice on stderr can suggest reinstalling. Never change stdout.
- **Leave `AGENTS.md` and `CLAUDE.md` alone by default.** If the CLI offers to edit them, write a clearly delimited managed block behind an explicit flag, as Next.js and Nx do.

### Vercel's `skills` CLI

[`skills`](https://github.com/vercel-labs/skills) (`npx skills add <source>`) is the most common way to install skills from a repository, with about 28 million downloads in the month to 2026-09-29. It maps 79 agents to their skill directories and keeps a `skills-lock.json` file with content hashes. It is the documented install path for Supabase, Sentry, Netlify, Expo, Prisma, and Google Workspace CLI. Vercel and Neon run it from their own CLIs. Stripe, Railway, Nx, Prisma, and Wrangler implement installation themselves.

Install the CLI's own skill with native code. Also publish the same skill in a public repository, so that `npx skills add <org>/<repo>` works too. Delegating installation to `skills` has these costs (source, `skills@1.7.0`):

- **No version matching.** `add` accepts git, URL, local path, and well-known sources, but not npm packages. Only the hidden `experimental_sync` command picks up skills from installed packages, and `update` skips local and `node_modules` sources.
- **Runtime fetch.** `npx skills` downloads an unpinned package at run time and needs Node 22.20 or newer. Skills from git sources follow a mutable branch.
- **Third-party telemetry.** `skills` reports the installing agent, the sources, and the skills to Vercel. `DO_NOT_TRACK` or `DISABLE_TELEMETRY` turns the reporting off. Never remove the user's opt-out variables when spawning `skills`. Neon strips both.
- **Overwrites edits.** `skills` deletes and rewrites skill directories and cannot tell a local edit from an upstream change.
- **Automatic consent.** Under a detected agent, `skills` assumes `-y`.

A native installer is small. It copies one directory to two locations, writes a hash manifest, and compares versions. Use the same directory layout as `skills` so both tools can coexist. Do not write `skills-lock.json`, because `skills` owns that file.

## MCP adapters

If you need an MCP adapter, have it call the same application operations and validators as the CLI. Expose a small, task-oriented tool set with structured results, as defined in the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). `cf` can emit MCP tool definitions from its command schemas. A remote MCP server cannot read a path in the agent's sandbox. File transfer needs an explicit upload capability or a URI that the harness can access. Do not send large file bodies through model context or base64 arguments.

[Anthropic's code-execution discussion](https://www.anthropic.com/engineering/code-execution-with-mcp) supports on-demand discovery and keeping intermediate data out of model context. It is not evidence that a CLI beats MCP in every case. Test both with real tasks.

## Evaluate with agents

Follow [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents). Evaluate with realistic tasks, not only unit tests.

- Run representative tasks in at least two shell-capable harnesses, one of them with a PTY, such as Gemini CLI. If an MCP client exists, run the tasks there too. Include fresh sessions, missing credentials, interrupted runs, and service failures.
- Measure the completion rate, the number of calls, output tokens, repeated side effects, recovery after interruption, and whether the agent relayed `by: "user"` steps instead of working around them.
- Test the contract directly with the Node test runner. Spawn the built binary without a TTY. Assert that stdout parses as a single JSON object that matches the envelope schema in the success, error, and interrupted cases, and that `data` matches the output schema. Assert the exit codes, and assert that stderr contains no JSON and no secrets.
- Snapshot the output of `acme schema` for every command, and fail CI on unreviewed changes. CI then catches a breaking change before it ships in a release that is not a major version.

## Node.js implementation

Target the supported Node.js release lines. v22 and v24 are LTS, and v26 is Current. v25 reached end of life on 2026-03-31 ([release schedule](https://nodejs.org/en/about/previous-releases)). Prefer built-ins to dependencies: `util.parseArgs`, `util.styleText`, `fetch`, `node:sqlite`, and `node:test`.

### Startup performance

Agents run many short commands, often one after another. Keep the cost of every metadata command (`--version`, `--help`, `schema`, `commands`) close to the cost of starting Node itself.

This research measured the cases below. Each time is the median of 15 to 30 runs after warmup.

| Case | Slower | Faster |
| --- | --- | --- |
| `node -e ''` baseline | Homebrew v26 build: 61 ms | Official v20 build: 34 ms |
| viem | Unbundled, 1,268 modules: 280 ms | Bundled with esbuild as ESM: 83 ms |
| ethers v6 | Unbundled: 126 ms | Bundled: 93 ms |
| `update-notifier`, 147 modules | Imported on its own: +64 ms | Not imported: +0 ms |
| 2-line script | `.ts` with type stripping: 87 ms | `.mjs`: 62 ms |
| 680 KB bundle | `.mts`: 143 ms | `.mjs`: 83 ms |
| `tsc --version` launcher | `npx --no-install tsc`: 320 ms | Installed `.bin/tsc`: 85 ms |
| `tsc --version`, TypeScript 5.9.3 | Compile cache off: 127 ms | Compile cache warm: 81 ms |

The number of modules decides most of the startup time. Loading 1,000 empty modules takes about 0.3 s on an M1 ([Marvin Hagemeister](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/)). In this research, the choice between ESM and CommonJS mattered far less than the module count.

Apply these techniques in order of impact:

1. **Bundle to one ESM file** with esbuild, Rolldown, or tsdown. An ESM bundle tree-shakes. For the same viem import, the CommonJS bundle was 3.3 MB and took 146 ms, and the ESM bundle was 0.68 MB and took 83 ms. pnpm 11 ships a single bundled file, and Wrangler ships a 14.8 MB bundle.
2. **Lazy-load commands and heavy dependencies** with a dynamic `import()` inside the command handler. Import deep subpaths instead of package barrels. `viem/utils` alone loaded 264 modules.
3. **Keep metadata commands static.** Build help, `schema`, and `commands` from a static definition module that imports no handlers or SDKs.
4. **Enable the compile cache from a tiny entry shim.** `module.enableCompileCache()` caches compiled code in the OS temp directory. It is available from v22.8 and is no longer experimental from v25.4.0 and v24.15.0. The cache does not cover static imports of the file that calls it, so the shim must load the real CLI with a dynamic import. The cache helps most with large single files. npm, ESLint, Prettier, Angular CLI, and Vercel use it. TypeScript 5.7 reported that `tsc --version` dropped from 122 ms to 48 ms ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/)).

   ```js
   #!/usr/bin/env node
   import module from 'node:module'

   module.enableCompileCache?.()
   await import('../dist/cli.js')
   ```

5. **Do no startup work.** Before dispatching the command, make no network calls and run no update checks, telemetry flushes, configuration discovery, or recursive filesystem scans. Run update checks only in interactive human mode, in a detached process, and import their libraries lazily.
6. **Ship compiled JavaScript.** Node refuses to strip types under `node_modules`, and type stripping adds measurable startup cost. Do not use `tsx` or `ts-node` at run time.
7. **Avoid launcher overhead.** In agent instructions, recommend installed binaries over `npx`. Do not start a second Node process to apply flags, as Wrangler's bin script does. Set options in code, or use `#!/usr/bin/env -S node <flags>`, which npm and pnpm shims accept.
8. **Consider snapshots and single executable applications last.** Startup snapshots (`--build-snapshot`) and single executable applications (SEA) can cut startup further. SEA uses the `useSnapshot` and `useCodeCache` options and, in v25.5+, `node --build-sea`. A snapshot took a viem CommonJS bundle from 146 ms to 83 ms. But snapshots cannot load user-land modules without bundling, and they reject ESM entries. The SEA options carry restrictions on ESM, `import()`, and the virtual file system ([SEA docs](https://nodejs.org/api/single-executable-applications.html)).

Measure with `hyperfine --warmup 3 "node -e ''" 'acme --version' 'acme schema --list'`. Profile with `node --cpu-prof`. Count loaded modules with a `module.registerHooks` load hook. Add a CI check that keeps metadata commands within a time budget relative to the `node -e ''` baseline.

### Signal handling

Harnesses stop commands with SIGTERM and send SIGKILL 50 to 200 ms later. Users press Ctrl+C, which sends SIGINT. Closing a terminal sends SIGHUP. Node handles these signals as follows ([signal events](https://nodejs.org/api/process.html#signal-events)), confirmed locally on v26.10.0:

- **Without a listener**, SIGINT, SIGTERM, and SIGHUP terminate the process immediately with the signal's default action. The shell sees `130` for SIGINT, `143` for SIGTERM, and `129` for SIGHUP. Node does not run `process.on('exit')` handlers, and pending asynchronous stdout writes are lost.
- **With a listener**, Node removes the default action and no longer exits on the signal. A listener that only logs keeps the process running. In a measurement, such a process exited with `0` after its work finished, instead of `143`. Libraries that install their own listeners, such as prompt and spinner packages, have the same effect.
- SIGKILL and SIGSTOP cannot be handled. Node ignores SIGPIPE by default, so a broken pipe surfaces as an EPIPE error instead. See [Exit and stream hygiene](#exit-and-stream-hygiene).
- On Windows, Ctrl+C delivers SIGINT, and closing the console delivers SIGHUP. A process can listen for SIGTERM, but Windows never delivers it.

Follow these rules for signals:

1. **Make interruption safe before handling it.** Persist operation state as work progresses, so that a SIGKILL, which no handler sees, leaves nothing to clean up. See [long-running commands](#output-size-and-long-running-commands). Print the operation ID to stderr when work starts. The ID then appears in the agent's merged output even if the final result never does.
2. **Handle the first signal, not the second.** Register listeners with `process.once`. The first signal cancels work. Because `once` removes the listener, a second signal gets the default action and terminates the process immediately (measured: `143` on the second SIGTERM). Never swallow signals.
3. **Cancel with `AbortSignal`.** Pass one `AbortSignal` to `fetch`, `timers/promises`, child processes, and SDK calls. Do not start new side effects after cancellation.
4. **Keep cleanup to milliseconds.** Release locks and record the interruption. Do not upload, flush telemetry, or wait on the network.
5. **Report, then re-raise.** In machine mode, write an `interrupted` result with a `next` step that inspects or resumes the operation. Wait for the write to finish, then re-raise the signal so the exit status is `128 + N` (measured: `130` after SIGINT, with the JSON delivered).
6. **Forward signals to child processes.** Ctrl+C in a terminal reaches the whole foreground process group, but a harness or supervisor may signal only the CLI's process. Forward SIGINT and SIGTERM to children, and wait briefly for them to exit.

```js
/** Aborts in-flight work on the first SIGINT, SIGTERM, or SIGHUP. */
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => controller.abort(signal))
}

/** Writes an interrupted result, then re-raises the signal for a 128 + N exit status. */
function exitOnSignal(signal, operationId) {
  const result = {
    error: { code: 'interrupted', message: `Interrupted by ${signal}.`, retryable: false },
    next: [{ by: 'agent', command: `acme operations resume ${operationId}`, description: 'Resume the interrupted operation' }],
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.kill(process.pid, signal))
}
```

### Exit and stream hygiene

- **Set `process.exitCode` instead of calling `process.exit()` after writing output.** Writes to pipes are asynchronous on POSIX ([Node docs](https://nodejs.org/api/process.html#a-note-on-process-io)). In this research, writing 4 MB and then calling `process.exit(1)` delivered only 65,536 bytes through a pipe.
- **Let the event loop drain.** Unref timers, close servers and database handles, and always consume or cancel `fetch` response bodies. In this research, an unconsumed body kept a process alive for 40 s ([undici docs](https://undici.nodejs.org/#/?id=garbage-collection)).
- **Handle EPIPE.** `console.log` ignores EPIPE, but `process.stdout.write` crashes with an unhandled error when the reader exits early, as `head` does. Stop writing and exit quietly.
- **Convert crashes into results.** Catch errors at the top level and in `uncaughtException` and `unhandledRejection` handlers. Emit an `internal_error` result in machine mode, and exit with `1`.

```js
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

/** Writes the final machine-mode result and sets the exit code. */
function emitResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = 'error' in result ? 1 : 0
}
```

## Survey of existing CLIs

### Patterns worth borrowing

| Reference | Observed behavior | Takeaway |
| --- | --- | --- |
| [Cloudflare `cf`](https://blog.cloudflare.com/cf-cli-local-explorer) ([source](https://github.com/cloudflare/cf)) | One schema generates commands and docs. JSON on stdout, `schema` discovery, MCP tool export, `--dry-run` on generated commands, and help that changes for agents. | One source of truth for parser, help, and schemas |
| [Vercel CLI](https://vercel.com/docs/cli/agent) | Agent detection turns on noninteractive mode. JSON errors on stdout with `status`, `reason`, `next`, and `userActionRequired`. | Structured next steps and action-required results |
| [Google Workspace CLI](https://github.com/googleworkspace/cli) | Runtime `schema` discovery, raw JSON input, dry runs, packaged skills, and JSON errors on stdout | Discoverable inputs, and skills shipped with the CLI |
| [GitHub CLI](https://cli.github.com/manual/gh_help_formatting) | `--json <fields>` selection with `--jq`, full help on usage errors for detected agents, and exit `0` on empty results | Field selection and agent-aware usage errors |
| [Railway CLI](https://github.com/railwayapp/cli) | Errors as `{error, code, hint}` on stdout, so agents can always parse stdout | JSON on stdout in every outcome |
| [Pulumi](https://github.com/pulumi/pulumi) | Exit codes declared a contract for automation. Stable `pulumi.cloud_api.*` error codes with suggestions. | Stable error codes with suggested fixes |
| [CLI Guidelines](https://clig.dev/) | Composable streams, a JSON mode, and terminal-aware presentation | Treat stdout as an API, and keep interactive presentation optional |
| [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents) | Task-oriented tools, compact responses, actionable errors, and evaluations | Fewer, higher-level commands, evaluated with real tasks |

### Exit codes in practice

| CLI | Codes | Where detail lives |
| --- | --- | --- |
| Cloudflare `cf` | `0`, `1`, `130` for a cancelled prompt, child codes passed through | A human-readable error box on stderr |
| GitHub CLI | `0`, `1`, `2` cancelled, `4` no credentials, `8` `pr checks` pending | stderr text |
| Vercel | `0`, `1` for nearly all errors, `2` usage | JSON `reason` (about 50 values) on stdout |
| Google Workspace CLI | `1` API, `2` auth, `3` validation, `4` discovery, `5` other | JSON `{error: {code, message, reason}}` on stdout |
| Pulumi | `2` to `9` and `255`, several not yet wired | JSON codes with suggestions |
| AWS CLI v2 | `0`, `1`, `2`, `130`, `252` to `255` | stderr text |
| Gemini CLI | `0`, `1`, `41` to `55`, `130` (the docs list four) | JSON `{type, message, code}` |
| Stripe, Netlify, Supabase, Neon, kubectl, gcloud, Codex | `0` and `1` | Varies |

Avoid these codes in every case: `2` (Bash builtin misuse and the Claude Code hook block), `124` (GNU `timeout`), `126` and `127` (the shell's "not executable" and "not found"), and `128` to `255` (signals). flyctl uses `126` and `127` for timeout and cancel, and Wrangler Pages uses `156` to `159`. Both collide with shell meanings.
