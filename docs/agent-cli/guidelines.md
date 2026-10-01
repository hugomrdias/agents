# CLI guidelines for agents

Research date: 2026-10-01. Scope: Node.js command-line tools that coding agents (Claude Code, Codex, Gemini CLI, Cursor, Copilot, and similar harnesses) and scripts invoke through a shell. Status: design guidelines derived from source inspection of existing CLIs and harnesses, their documentation, and local measurements. `acme` is a placeholder executable name.

Evidence notes: “source” means the behavior was read in the named repository; “docs” means official documentation; “measured” means a local measurement on Node v26.10.0 (Homebrew build), Apple M1 Pro, during this research. Absolute timings vary with hardware and Node build; compare ratios, not milliseconds.

## Summary

1. **stdout is an API.** In machine mode, every invocation writes exactly one JSON object to stdout, on success and on error. Human-readable diagnostics go to stderr.
2. **Exit `0` or `1`.** Exit `0` if and only if the result has `ok: true`. Everything else exits `1`. The JSON result carries the diagnosis.
3. **Errors say what to do next.** Every error has a stable `code`, a one-sentence `message`, a `retryable` flag, and `next` steps marked as runnable by the agent or requiring the user.
4. **Detect agents to change presentation, never semantics.** An agent changes defaults: JSON output, no prompts, no color or spinners, agent-oriented help. It never changes permissions, exit codes, or what a command does.
5. **Discovery works offline.** `acme schema <command>` returns input, output, and error schemas without credentials or network access, generated from the same definitions as the parser and help.
6. **Never block on a human.** No prompts, pagers, or browser launches in agent or noninteractive mode. Missing input or confirmation is an error with a `next` step.
7. **Keep results small and bounded.** Harnesses truncate output at roughly 10k tokens or 30k–40k characters.
8. **Start fast.** Bundle, lazy-load commands and heavy dependencies, keep metadata commands free of SDK imports, and exit cleanly.

## How agents run commands

Agents read a command's output as text in their context. The details below determine which CLI behaviors help or hurt.

| | Claude Code (Bash tool) | Codex CLI (`exec_command`) | Gemini CLI (`run_shell_command`) |
| --- | --- | --- | --- |
| stdout/stderr | Merged into one stream (docs, probe) | Merged in arrival order ([source](https://github.com/openai/codex/blob/57ac6f5/codex-rs/core/src/unified_exec/process.rs#L369)) | Merged into one `output` string (source: `shellExecutionService.ts`) |
| TTY | No; stdin, stdout, and stderr are not TTYs | No by default; the model can request one | **Yes**, a node-pty PTY by default |
| stdin | Immediate EOF | Closed | PTY; a prompt waits for input |
| Output limit | ~30,000 characters inline; beyond that, a file path plus the first 2,000 characters ([docs](https://code.claude.com/docs/en/tools-reference)) | 10,000-token budget; truncates the middle | Over 40,000 characters, keeps first 20% and last 80% and saves the full output to a file |
| Timeout | 2 min default, 10 min max ([docs](https://code.claude.com/docs/en/env-vars)) | Returns after 10 s by default; the process continues in a session the model can poll | 300 s of inactivity; output resets it |
| Kill | Not documented | SIGTERM, 50 ms grace, then SIGKILL; SIGKILL on timeout | SIGTERM, 200 ms grace, then SIGKILL |
| Exit code | Shown; any nonzero exit except from `grep`, `find`, `diff`, `test`, and similar is a failure | Shown as `Exit code: N` | Shown when nonzero |
| Environment | `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, `AI_AGENT` observed | `NO_COLOR=1`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `CODEX_CI=1`, `CODEX_THREAD_ID` | `GEMINI_CLI=1`, `TERM=xterm-256color`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0` |

Codex and Gemini were checked at [openai/codex@57ac6f5](https://github.com/openai/codex/tree/57ac6f5) and [google-gemini/gemini-cli@c6bccb7](https://github.com/google-gemini/gemini-cli/tree/c6bccb7). Claude Code facts come from its documentation and a probe of a v2.1.284 session.

Consequences for CLI design:

- **Streams merge.** The model sees stderr and stdout together. Separation still matters for scripts and for harnesses that capture streams separately, but stderr is not a private channel: whatever goes there costs tokens. Do not duplicate the JSON error as verbose stderr text.
- **`isTTY` does not mean a human.** Gemini runs commands in a PTY, so a TTY check alone would enable prompts, spinners, and color there. Use agent detection as well.
- **Grace periods are tens of milliseconds.** A signal handler cannot save significant state before SIGKILL. Persist progress while working.
- **Truncation differs by harness.** Some keep the head, some the tail, some both. A result that fits within the limits is the only reliable result.
- **The exit code is shown as a number.** No harness maps CLI-specific codes to meanings; the model reasons from the number plus the output text.

## Output contract

### Streams and modes

| Mode | Selected by | stdout | stderr |
| --- | --- | --- | --- |
| Machine | `--json`, `ACME_OUTPUT=json`, or a detected agent | One JSON object, written once at the end | A short human-readable summary on failure; progress lines only for long-running work |
| Human | Default in an interactive terminal; `--format human` overrides a detected agent | Concise human-readable result | Errors, warnings, progress, spinners (TTY only) |
| Events | `--events` | NDJSON events with sequence numbers, ending with the same result object as machine mode | As machine mode |

Rules:

- An explicit flag always wins over environment variables and detection. `--json` and `--events` are mutually exclusive.
- Machine-mode stdout contains nothing but the result: no banners, update notices, warnings, ANSI codes, or progress.
- Write the JSON result as a single `write` after all stderr output, so merged streams never interleave inside it.
- Emit compact, single-line JSON followed by a newline. It costs fewer tokens than pretty-printed JSON and composes with NDJSON tools.
- Commands whose output is raw data (for example a binary download to stdout) cannot also emit JSON on stdout; reject the conflicting combination or require `--output <file>`.
- Respect `NO_COLOR`, `FORCE_COLOR`, and `TERM=dumb`; disable color and animation for detected agents even when a PTY is present.

Returning error JSON on stdout follows Vercel ([`agent-output.ts`](https://github.com/vercel/vercel/blob/c628be7/packages/cli/src/util/agent-output.ts)), Railway, PlanetScale, Google Workspace CLI, and Supabase's TypeScript rewrite. GitHub CLI and Cloudflare's `cf` write errors to stderr as text only, which forces agents to parse prose for auth and not-found cases. In human mode errors still go to stderr.

### Result envelope

Every result shares a small envelope. Command-specific fields sit beside it and are defined by the command's output schema.

```json
{
  "ok": true,
  "item": { "id": "itm_123", "name": "report", "url": "https://example.com/itm_123" }
}
```

| Field | Meaning |
| --- | --- |
| `ok` | `true` only when the command's contract is fully satisfied. Determines the exit code. |
| `error` | Present when `ok` is `false`. |
| `next` | Optional ordered list of recommended follow-up steps, on success or failure. |
| Command fields | Partial results are allowed on failure, for example a created resource whose verification has not finished. |

Represent integers that can exceed 2^53 (amounts, chain IDs, byte counts of large stores) as decimal strings, and include units for quantities. Use ISO 8601 UTC timestamps. Prefer meaningful, stable identifiers and names over opaque UUIDs alone.

### Errors, next steps, and retries

```json
{
  "ok": false,
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
| `error.code` | Stable `snake_case` identifier, listed in the command's error schema. Agents and scripts branch on this, not on the message. |
| `error.message` | One actionable sentence. No stack traces outside `--debug`. |
| `error.retryable` | `true` only if running **the same command again** is safe and may succeed without anyone changing anything. |
| `error.retryAfterSeconds` | Optional delay before retrying, from `Retry-After` or local policy. |
| `error.details` | Optional structured context, for example `[{ "path": "--limit", "message": "must be ≤ 100" }]`. |
| `next[].by` | `agent` if the agent can perform the step; `user` if a human must act (sign in, approve spending, confirm deletion, fix configuration). |
| `next[].command` | Optional exact command line. Must be runnable as written, with real IDs filled in. |
| `next[].description` | What the step does and why. |

A `next` step with `by: "user"` is the **action-required** signal: the agent should stop and relay the step to its user rather than attempt workarounds. Vercel models the same idea as `status: "action_required"` with `userActionRequired` ([source](https://github.com/vercel/vercel/blob/c628be7/packages/cli/src/util/agent-output-constants.ts)).

Retry rules:

- Retry idempotent requests (reads, rate limits, `5xx`, connection resets) inside the CLI with bounded backoff before failing. Return `retryable: true` only when that budget is exhausted and a later attempt could still succeed.
- A mutation whose outcome is unknown (timeout after submission, crash mid-request) is **not** retryable. Return `retryable: false` with a `next` step that inspects or resumes the operation, so the agent does not repeat a side effect.
- Make mutations idempotent where possible (client-generated request IDs, “create if absent”), or give each mutation an operation ID that a `resume` or `status` command accepts.
- Validation, authorization, not-found, and policy errors are never retryable.

Common codes: `invalid_input`, `auth_required`, `permission_denied`, `not_found`, `conflict`, `rate_limited`, `service_unavailable`, `timeout`, `confirmation_required`, `internal_error`. Domain-specific codes are encouraged; generic `failed` is not.

## Exit codes

**Use only `0` and `1`.** Exit `0` when `ok` is `true`; exit `1` otherwise, including usage errors, action-required results, partial results, and timeouts.

The survey supports this:

- **Harnesses do not interpret codes.** Codex and Gemini print the number into context; Claude Code treats any nonzero exit as failure. Only the accompanying text explains what happened.
- **Rich taxonomies are rare and inconsistent.** Most CLIs use `0`/`1` only: Stripe, Netlify, Supabase, Neon, kubectl, gcloud, Codex, and `cf`. Where taxonomies exist, they disagree: “auth required” is `4` in gh, `3` in Pulumi, `2` in Google Workspace CLI, `41` in Gemini CLI, and `253` in AWS CLI. Exit `2` means usage error (Bash builtins, argparse, cobra, clap, Vercel), cancelled (gh), fatal (PlanetScale), changes present (Terraform `-detailed-exitcode`), auth (Google Workspace CLI), or incomplete (Filecoin Pin).
- **The JSON result already carries the detail.** An exit code can add at most a few bits, and a second source of truth can disagree with the JSON.
- **Exit `2` has special meaning in Claude Code hooks.** It blocks the action and feeds stderr to the model ([docs](https://code.claude.com/docs/en/hooks)). A CLI that exits `2` for usage errors blocks an agent unexpectedly when used as a hook.
- **`1` is what Node uses for an uncaught exception**, so a crash still reads as failure.

Scripts branch on the JSON instead: `acme items get itm_123 --json | jq -e '.ok'` or `jq -r '.error.code'`.

The codes the CLI chooses are `0` and `1`; a few others come from the platform:

- **Signals.** When terminated by a signal, the shell reports `128 + N` (`130` for SIGINT, `143` for SIGTERM). After any brief cleanup, re-raise the signal rather than exiting `0` or `1`, so callers and shells see the interruption. See [Signal handling](#signal-handling).
- **Child processes.** A command whose purpose is to run another program (`acme run -- <cmd>`) passes through the child's exit code, as uv, Railway, and `cf` do. Document such commands explicitly.
- **Node runtime failures.** Node itself can exit with other codes on internal errors (for example `13` for an unsettled top-level await, or an abort on heap exhaustion). Install `uncaughtException` and `unhandledRejection` handlers that emit an `internal_error` result and exit `1`.
- **Help and version.** `--help` and `--version` exit `0`. Do not add opt-in exit codes such as Terraform's `-detailed-exitcode`; add a JSON field instead.

## Agent detection and help

Detect agents from environment variables, checking the emerging generic convention first:

1. `AI_AGENT` (promoted by [`@vercel/detect-agent`](https://www.npmjs.com/package/@vercel/detect-agent), honored by gh and [`std-env`](https://github.com/unjs/std-env)), then `AGENT` (Amp, Goose).
2. Vendor variables: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CODEX_THREAD_ID`, `CODEX_CI`, `GEMINI_CLI`, `CURSOR_AGENT`, `OPENCODE`, `AUGMENT_AGENT`, `COPILOT_AGENT_SESSION_ID`, `AMP_CURRENT_THREAD_ID`, `QWEN_CODE_SESSION_ID`, among others. `cf` keeps a maintained list ([source](https://github.com/cloudflare/cf/blob/45f8332/packages/cli/src/lib/agent-context.ts)).
3. A user override: `--agent`/`--no-agent` or `ACME_AGENT=0|1`.

Prefer a maintained library (`std-env` exports `isAgent` and `agent`; `@vercel/detect-agent` is similar) over a private list. Do not treat `CI` or `TERM` as agent signals. Detection is heuristic: `CLAUDECODE=1` is also set in IDE terminals a human may use, which is why detection may only change presentation defaults and must be overridable.

What detection changes:

| Behavior | Human default | Agent default |
| --- | --- | --- |
| Output | Human mode | Machine mode |
| Prompts, pagers, browser launch | Allowed on a TTY | Never |
| Color, spinners, animation | On a TTY | Off |
| Usage error | Short usage line | Full help for the attempted command (gh does this; [source](https://github.com/cli/cli/blob/fc4b137/internal/ghcmd/cmd.go#L270-L300)) |
| Help | Narrative | Examples, output fields, and error codes first, with a pointer to `acme schema` |
| Long-running progress | Spinner | A plain progress line on stderr every 15–30 s, which also resets inactivity timeouts |

What detection never changes: permissions, confirmations required for destructive or paid actions, exit codes, the JSON schema, or which operation runs. Running under an agent is not authorization.

Help written for agents:

- Start with one or two runnable examples, then flags, then the output fields and error codes, then a pointer to `acme schema <command>`.
- Use consistent verbs and flags across commands. `cf` enforces naming at the schema layer: always `get`, never `info`; always `--force` ([blog](https://blog.cloudflare.com/cf-cli-local-explorer)).

## Discovery and schemas

| Command | Returns |
| --- | --- |
| `acme schema <command…>` | JSON Schema (2020-12) for the command's input, output, and error codes |
| `acme schema --list` or `acme commands --json` | The full command tree with one-line descriptions, in one call |

- Discovery must work without credentials, configuration, or network access, and must not load SDKs (see [Startup performance](#startup-performance)).
- Generate the parser, help text, validation, JSON Schemas, and any MCP tool definitions from one command definition. `cf` generates its CLI and docs from one TypeScript schema; Google Workspace CLI exposes `gws schema <method>` at runtime ([post](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/)).
- The schema describes the installed CLI, so its version is the CLI version; there is no separate schema or result version. Agents read the schema from the binary they run. Scripts that depend on output fields pin the CLI version, and removing or renaming fields, error codes, or flags requires a major CLI release.

## Input

- Accept human-friendly flags for simple cases and `--input <file.json>` (or `--input -` for stdin) for complex requests. Validate both against the same input schema and document precedence when both are given.
- Do not require shell-escaped JSON for simple values such as file paths.
- Support `-` for stdin and stdout where meaningful.
- Harden input against model mistakes: reject control characters, path traversal, query strings or fragments embedded in IDs, and unknown flags (`util.parseArgs` with `strict: true`). Report all invalid fields at once in `error.details`.
- Never accept secrets as flag values; they appear in process listings, shell history, and agent transcripts. Read them from environment variables, a credential store, a file, or stdin.

## Noninteractive behavior and safety

- Prompt only when stdin and stdout are TTYs **and** no agent or CI is detected **and** `--no-input` is absent. Otherwise, a missing required value is an `invalid_input` error naming the flag to pass.
- Destructive and paid actions require `--yes` (or `--force`, consistently chosen) when not prompting. Without it, return `confirmation_required` with exit `1` and a `next` step for the user. Never print “Aborted” and exit `0`; `cf` does this for noninteractive deletes ([source](https://github.com/cloudflare/cf/blob/45f8332/packages/cli/src/lib/prompt.ts#L323-L330)), which agents read as success.
- Never open a browser, pager, or editor in agent or noninteractive mode. Authentication flows that need a browser return `auth_required` with a user step.
- Offer `--dry-run` on mutating commands: validate, resolve, and estimate cost, and return what would happen in the same result shape, without side effects.
- Never print secrets, tokens, or private keys, including in errors and debug output. Redact values in echoed configuration.
- Treat data fetched from remote services as untrusted content. Return it in clearly named data fields and never phrase CLI output so that remote text reads as instructions to the agent.

## Output size and long-running commands

- List commands default to a bounded page (for example 20 items) with cursor pagination (`nextCursor`) and `--limit`.
- Support `--fields` to select output fields, as gh does with `--json <fields>` ([docs](https://cli.github.com/manual/gh_help_formatting)).
- Keep a typical result well under 10,000 tokens. Write large payloads (logs, file contents, archives) to a file and return its path, size, and digest.
- Do not put file bytes, full histories, or verbose traces in ordinary results; provide a `--verbose` or separate inspect command.
- Commands that can outlast harness timeouts should persist an operation record before starting side effects, return its ID early or on interruption, and offer `status`/`wait`/`resume` commands. Allow `--no-wait` to return immediately after submission.
- Persist progress continuously, not in a signal handler; harnesses allow 50–200 ms before SIGKILL.

## Configuration and environment

- Resolve settings in a documented order: flag, environment variable, profile/config file, default. Show resolved values and their sources in `acme config --json` or `acme doctor --json`.
- Prefix environment variables (`ACME_*`). Respect standard variables: `NO_COLOR`, `FORCE_COLOR`, `CI`, `HTTP(S)_PROXY`, `XDG_*`.
- Store state in the platform's application data or state directory with an override variable for CI and ephemeral harnesses.
- Never perform blocking update checks in agent, CI, or machine mode, and never write update notices to stdout. See [Telemetry](#telemetry) for usage reporting.

## Telemetry

Most developer CLIs collect usage telemetry, opt-out by default. Agents are now a large share of invocations, and telemetry is how a CLI team learns which commands agents call, where they fail, and which errors they cannot recover from. Telemetry must never change what a command does, what it prints to stdout, its exit code, or how long it takes.

### Opting out

| Control | Behavior |
| --- | --- |
| `DO_NOT_TRACK` | Disables telemetry when set to anything other than empty, `0`, or `false`. |
| `ACME_TELEMETRY=0` | Product-specific opt-out. `ACME_TELEMETRY=log` prints each event to stderr instead of sending it (as `GH_TELEMETRY=log` does). |
| `acme telemetry status\|enable\|disable` | Persists the setting in configuration. `status --json` reports the effective state and which source decided it (environment, configuration, or default), as `cf cli telemetry` does. |

Any opt-out wins: if `DO_NOT_TRACK`, `ACME_TELEMETRY`, or the configuration disables telemetry, nothing is sent, and `ACME_TELEMETRY=1` does not override `DO_NOT_TRACK`. The `telemetry` command itself never reports, so disabling telemetry does not send an event (Prisma does the same).

`DO_NOT_TRACK` has no specification, and its original site, consoledonottrack.com, no longer hosts the proposal, so do not link to it. Support is common but not universal (source unless noted):

| Honors `DO_NOT_TRACK` | Own opt-out only |
| --- | --- |
| gh (`GH_TELEMETRY` takes precedence), Turborepo, Wrangler and `cf` (override everything), Nuxt, Supabase, Railway, Stripe CLI, Prisma 8, Bun (crash reports), Claude Code (strings in the compiled binary) | Next.js (`NEXT_TELEMETRY_DISABLED`), Vercel (`VERCEL_TELEMETRY_DISABLED`), Astro, Netlify (flags only), Angular (`NG_CLI_ANALYTICS`), Storybook, Expo, Homebrew (`HOMEBREW_NO_ANALYTICS`), .NET (`DOTNET_CLI_TELEMETRY_OPTOUT`), Gemini CLI and Codex (configuration only) |

Values accepted differ: Supabase and Prisma accept only `1`, most accept `1` or `true`, and Bun and Nuxt accept any truthy value. The rule above covers all of them.

### Consent and notice

- **Default.** Opt-out with a notice is the common choice (Turborepo, Next.js, Vercel, Wrangler, gh, Homebrew). Nuxt and Angular ask for consent in an interactive terminal and stay off otherwise. Go chose the most conservative model after public debate: since Go 1.23, the default mode `local` collects counters on disk and uploads nothing unless the user runs `go telemetry on` ([Go telemetry](https://go.dev/doc/telemetry), [rationale](https://research.swtch.com/telemetry-opt-in)). Decide deliberately and record why.
- **Notice.** On first run, print a one-line notice with the opt-out instructions to stderr in every mode, and record that it was shown. Never print it to stdout. Homebrew sends nothing until the notice has been shown.
- **Documentation.** Publish the list of events and fields, and keep the event schema in the repository so reviewers see changes.

### What to collect

| Collect | Never collect |
| --- | --- |
| Command path and flag **names** | Positional arguments and flag values |
| Outcome: `ok`, `error.code`, duration | Error messages, stack traces with paths, response bodies |
| CLI version, Node version, OS, architecture | File paths, file contents, project or repository names |
| `ci`, `tty`, mode (`interactive`, `noninteractive`, `ci`) | Environment variable values, tokens, account emails |
| Detected agent name | Raw agent session IDs or prompts |
| A random installation ID, generated locally | Hardware identifiers or IP-derived identity |

If the CLI needs to group events by project, hash an identifier with a salt that is generated locally and never sent; Next.js and Turborepo do this. Prisma 8 records only flags typed on the command line, without values; Vercel redacts `--project` values.

### Identifying agents

Yes: record the detected agent. Turborepo, Next.js, Vercel, `cf`, Wrangler, gh, Netlify, Supabase, Stripe, Prisma, Storybook, and Railway all do, usually with the same detection as [Agent detection and help](#agent-detection-and-help).

- Record a normalized agent name (`claude-code`, `codex`, `gemini-cli`), its version when available, and which variable matched, as Netlify does.
- To group the commands of one agent session, send a salted hash, never the raw session ID. `cf` sends `sha256("cf-agent-session-v1", deviceId, agent, sessionId)` truncated to 32 hex characters.
- Measure what agents need: error codes by command and agent, repeated identical failing calls, `next` steps that were followed, how often `schema` or `--help` precede a successful call, and commands interrupted by harness timeouts.
- Agent identity in API requests is a separate decision. gh appends `Agent/<name>` to its `User-Agent`, and `cf` sends `X-CF-CLI-Agent`; neither header is covered by their telemetry opt-outs. If you send one, document it and state whether the opt-outs apply.

### Sending

- **Never block or fail the command.** Send from a detached, unref'd child process (Next.js, Vercel, gh, Prisma), or in-process with a short timeout such as `AbortSignal.timeout(1000)` (`cf`) and an unref'd handle. A pending in-process request delays exit for its full timeout; a detached sender keeps that off every command's critical path.
- **Swallow all telemetry errors.** Show them only with `ACME_TELEMETRY=log` or `--debug`.
- **Load telemetry code lazily**, after the command result is written, so it never adds to startup time (see [Startup performance](#startup-performance)).
- **Skip sending without network.** Skip sending in offline mode and when `CODEX_SANDBOX_NETWORK_DISABLED` is set. Expo disables telemetry with `EXPO_OFFLINE`. Never retry telemetry uploads in the foreground.
- **Do not send on interruption** (see [Signal handling](#signal-handling)); spool the event locally and send it with a later invocation if it matters.
- **Decide CI explicitly.** Netlify and Prisma 8 disable telemetry in CI; Turborepo, Vercel, Wrangler, and gh send with a `ci` field. Either way, record `ci` so agent, CI, and human usage can be separated.

## Agent Skills

An [Agent Skill](https://agentskills.io/specification) is a directory with a `SKILL.md`: `name` and `description` frontmatter, then instructions. Agents load only the metadata at startup and read the body when a task matches, so a skill is the cheapest way to teach an agent a CLI's workflow. The [OpenAI](https://developers.openai.com/plugins/concepts/skills) and [Claude Code](https://code.claude.com/docs/en/skills) documentation describe the harness side.

The specification does not mandate a location, but recommends scanning project `.agents/skills` and user `~/.agents/skills` alongside each client's native directory ([client guidance](https://agentskills.io/client-implementation/adding-skills-support)). Codex, Cursor, Gemini CLI, Copilot, OpenCode, Amp, and Cline read project `.agents/skills`; Claude Code reads only `.claude/skills` and `~/.claude/skills`. Installers therefore write both.

### Skill content

- **Teach the workflow, not the reference.** Cover the main tasks and the few rules the model needs: use machine output, branch on `error.code`, relay `by: "user"` steps, resume rather than repeat mutations. Keep the body well under 500 lines.
- **Point to version-matched details.** Flags and fields belong in `acme schema` and `--help`, which always match the installed binary. Turborepo's skill only points to documentation shipped inside the installed `turbo` package, which “match the installed version exactly”; Next.js points `AGENTS.md` to `node_modules/next/dist/docs/`.
- **Ship the skill in the npm package** as `skills/<name>/SKILL.md` (the layout Prisma uses and the `skills` CLI scans for), and record the CLI version in frontmatter `metadata`.
- **Do not depend on the skill for correctness.** The CLI enforces the contract; the skill only makes the first call more likely to succeed.

### A setup command

Yes, provide one, opt-in and scriptable. Stripe (`stripe agent setup`), Railway (`railway setup agent`, `railway skills`), Nx (`nx configure-ai-agents`), Prisma (`prisma skills sync`), Vercel (`vercel skills`), and Neon (`neon init`, `neon skills`) all do. Without it, users copy files by hand or pull an unversioned copy from a repository.

| Command | Behavior |
| --- | --- |
| `acme skills install [--agent <name>…] [--scope project\|global] [--force]` | Copies the bundled skill to `.agents/skills/acme/` and to `.claude/skills/acme/` (or the user-level equivalents). Defaults to project scope. |
| `acme skills status --json` | Reports each installed copy, its recorded CLI version, whether it is stale relative to the running CLI, and whether it was edited. |
| `acme skills uninstall` | Removes only files the CLI installed and has not been edited. |

Rules:

- **Never install as a side effect.** Do not write skills or edit `AGENTS.md`/`CLAUDE.md` from unrelated commands or `postinstall` scripts. Next.js writes agent files during `next dev`, and Prisma's `init` adds a `postinstall` sync; both surprise users who did not ask. Wrangler's post-command offer is acceptable only because it runs on a TTY, outside CI, and is remembered.
- **Follow the output contract.** `-y` and `--json` make the command usable by agents; an agent may run it when its user asks. Global scope writes to the home directory and must be requested explicitly with `--scope global`.
- **Protect user edits.** Keep a manifest of installed file hashes and skip modified or unmanaged skill directories unless `--force` is given (Railway keeps a hash manifest; Prisma refuses unmanaged directories).
- **Detect staleness.** When the installed skill's version differs from the running CLI, `skills status` reports it, and a short stderr notice in human mode can suggest reinstalling. Never change stdout.
- **Leave `AGENTS.md` and `CLAUDE.md` alone by default.** If offered, write a clearly delimited managed block behind an explicit flag, as Next.js and Nx do.

### Vercel's `skills` CLI

[`skills`](https://github.com/vercel-labs/skills) (`npx skills add <source>`, about 28 million downloads in the month to 2026-09-29) is the de facto way to install skills from a repository. It maps 79 agents to their directories, keeps a `skills-lock.json` with content hashes, and is the documented install path for Supabase, Sentry, Netlify, Expo, Prisma, and Google Workspace CLI. Vercel and Neon run it from their own CLIs. Stripe, Railway, Nx, Prisma, and Wrangler implement installation themselves.

Implement installation of the CLI's own skill natively; publish the same skill in a public repository so `npx skills add <org>/<repo>` also works. Delegating has costs (`skills@1.7.0`, source):

- **No version matching.** `add` accepts git, URL, local path, and well-known sources, not npm packages. Installed-package skills are only picked up by the hidden `experimental_sync` command, and `update` skips local and `node_modules` sources.
- **Runtime fetch.** `npx skills` downloads an unpinned package at run time and needs Node 22.20 or newer; skills from git sources follow a mutable branch.
- **Third-party telemetry.** It reports the installing agent, sources, and skills to Vercel (disabled by `DO_NOT_TRACK` or `DISABLE_TELEMETRY`). Never remove the user's opt-out variables when spawning it; Neon strips both.
- **Overwrites edits.** It deletes and rewrites skill directories and cannot tell a local edit from an upstream change.
- **Automatic consent.** Under a detected agent it assumes `-y`.

A native installer is small: copy one directory to two locations, write a hash manifest, and compare versions. Use the same directory layout as `skills` so both tools coexist, but do not write `skills-lock.json`, which that tool owns.

## MCP adapters

An MCP adapter, if needed, should call the same application operations and validators as the CLI and expose a small, task-oriented tool set, with structured results as defined in the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). `cf` can emit MCP tool definitions from its command schemas. A remote MCP server cannot read a path from the agent's sandbox; file transfer needs an explicit upload capability or a harness-accessible URI. Do not send large file bodies through model context or base64 arguments.

[Anthropic's code-execution discussion](https://www.anthropic.com/engineering/code-execution-with-mcp) supports on-demand discovery and keeping intermediate data out of model context. It is not evidence that a CLI universally outperforms MCP; test both with real tasks.

## Evaluate with agents

Follow [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents): evaluate with realistic tasks, not only unit tests.

- Run representative tasks in at least two shell-capable harnesses (one with a PTY, such as Gemini CLI) and, if one exists, an MCP client. Include fresh sessions, missing credentials, interrupted runs, and service failures.
- Measure completion rate, number of calls, output tokens, repeated side effects, recovery after interruption, and whether `by: "user"` steps were relayed instead of worked around.
- Test the contract directly with the Node test runner: spawn the built binary without a TTY, assert that stdout parses as a single JSON object matching the output schema in success, error, and interrupted cases, assert exit codes, and assert that stderr contains no JSON or secrets.
- Snapshot the output of `acme schema` for every command and fail CI on unreviewed changes, so breaking changes are caught before a release that is not a major version.

## Node.js implementation

Target the supported Node.js release lines: v22 and v24 are LTS and v26 is Current; v25 reached end of life on 2026-03-31 ([release schedule](https://nodejs.org/en/about/previous-releases)). Prefer built-ins over dependencies: `util.parseArgs`, `util.styleText`, `fetch`, `node:sqlite`, `node:test`.

### Startup performance

Agents run many short commands, often sequentially. Every metadata command (`--version`, `--help`, `schema`, `commands`) should cost little more than starting Node itself.

Measurements from this research (median of 15–30 runs after warmup):

| Case | Time |
| --- | --- |
| `node -e ''` baseline (Homebrew v26 / official v20 build) | 61 ms / 34 ms |
| viem unbundled (1,268 modules) → bundled with esbuild, ESM | 280 ms → 83 ms |
| ethers v6 unbundled → bundled | 126 ms → 93 ms |
| Importing only `update-notifier` (147 modules) | +64 ms |
| 2-line `.ts` with type stripping vs `.mjs` | 87 ms vs 62 ms |
| 680 KB bundle as `.mts` vs `.mjs` | 143 ms vs 83 ms |
| Installed `.bin/tsc --version` vs `npx --no-install tsc` | 85 ms vs 320 ms |
| `tsc --version` (TypeScript 5.9.3), compile cache off vs warm | 127 ms vs 81 ms |

Module count dominates: loading 1,000 empty modules takes about 0.3 s on an M1 ([Marvin Hagemeister](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/)), and in our measurement ESM versus CommonJS mattered far less than the number of modules.

In order of impact:

1. **Bundle to one ESM file** with esbuild, Rolldown, or tsdown. An ESM bundle tree-shakes; the CommonJS bundle of the same viem import was 3.3 MB and 146 ms versus 0.68 MB and 83 ms. pnpm 11 ships a single bundled file; Wrangler ships a 14.8 MB bundle.
2. **Lazy-load commands and heavy dependencies** with dynamic `import()` inside the command handler. Import deep subpaths instead of package barrels (`viem/utils` alone loaded 264 modules).
3. **Keep metadata commands static.** Build help, `schema`, and `commands` from a static definition module that imports no handlers or SDKs.
4. **Enable the compile cache from a tiny entry shim.** `module.enableCompileCache()` (v22.8+, no longer experimental since v25.4.0/v24.15.0) caches compiled code in the OS temp directory. Static imports of the file that calls it are not cached, so the shim must load the real CLI dynamically. It helps most with large single files; npm, ESLint, Prettier, Angular CLI, and Vercel use it, and TypeScript 5.7 reported `tsc --version` dropping from 122 ms to 48 ms ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/)).

   ```js
   #!/usr/bin/env node
   import module from 'node:module'

   module.enableCompileCache?.()
   await import('../dist/cli.js')
   ```

5. **Do no startup work.** No network calls, update checks, telemetry flushes, configuration discovery, or recursive filesystem scans before dispatching the command. Run update checks only in interactive human mode, in a detached process, and import their libraries lazily.
6. **Ship compiled JavaScript.** Node refuses to strip types under `node_modules`, and type stripping adds measurable startup cost. Do not use `tsx` or `ts-node` at runtime.
7. **Avoid launcher overhead.** Recommend installed binaries over `npx` in agent instructions. Avoid re-executing Node to apply flags (Wrangler's bin script starts a second Node process); set options in code, or use `#!/usr/bin/env -S node <flags>`, which npm and pnpm shims accept.
8. **Consider snapshots and single executable applications last.** Startup snapshots (`--build-snapshot`) and SEA (`useSnapshot`, `useCodeCache`, `node --build-sea` in v25.5+) can cut further time (a viem CommonJS bundle: 146 ms → 83 ms with a snapshot), but snapshots cannot load user-land modules without bundling, reject ESM entries, and SEA options carry ESM, `import()`, and VFS restrictions ([SEA docs](https://nodejs.org/api/single-executable-applications.html)).

Measure with `hyperfine --warmup 3 "node -e ''" 'acme --version' 'acme schema --list'`, profile with `node --cpu-prof`, and count loaded modules with a `module.registerHooks` load hook. Add a CI budget for metadata commands relative to the `node -e ''` baseline.

### Signal handling

Harnesses stop commands with SIGTERM and follow with SIGKILL after 50–200 ms; users press Ctrl+C (SIGINT); closing a terminal sends SIGHUP. Node's behavior ([signal events](https://nodejs.org/api/process.html#signal-events)), confirmed locally on v26.10.0:

- **Without a listener**, SIGINT, SIGTERM, and SIGHUP terminate the process immediately with the signal's default action. The shell sees `130`/`143`/`129`, `process.on('exit')` handlers do not run, and pending asynchronous stdout writes are lost.
- **With a listener**, the default action is removed and Node no longer exits. A listener that only logs keeps the process running (measured: exit `0` after its work finished, instead of `143`). Libraries that install their own listeners (prompt and spinner packages) have the same effect.
- SIGKILL and SIGSTOP cannot be handled. SIGPIPE is ignored by default; broken pipes surface as EPIPE errors instead (see below).
- On Windows, Ctrl+C delivers SIGINT and closing the console delivers SIGHUP; SIGTERM can be listened for but is never delivered.

Rules:

1. **Make interruption safe before handling it.** Persist operation state as work progresses (see [long-running commands](#output-size-and-long-running-commands)) so that a SIGKILL, which no handler sees, leaves nothing to clean up. Print the operation ID to stderr when work starts, so it appears in the agent's merged output even if the final result never does.
2. **Handle the first signal, not the second.** Register listeners with `process.once`. The first signal cancels work; because the listener is removed, a second signal gets the default action and terminates immediately (measured: `143` on the second SIGTERM). Never swallow signals.
3. **Cancel with `AbortSignal`.** Pass one signal to `fetch`, `timers/promises`, child processes, and SDK calls. Do not start new side effects after cancellation.
4. **Keep cleanup to milliseconds.** Release locks and record the interruption; do not upload, flush telemetry, or wait on the network.
5. **Report, then re-raise.** In machine mode, write an `interrupted` result with a `next` step to inspect or resume the operation, wait for the write to complete, then re-raise the signal so the exit status is `128 + N` (measured: `130` after SIGINT, with the JSON delivered).
6. **Forward signals to child processes.** A Ctrl+C in a terminal reaches the whole foreground process group, but a harness or supervisor may signal only the CLI's process. Forward SIGINT and SIGTERM to children and wait briefly for them.

```js
/** Aborts in-flight work on the first SIGINT, SIGTERM, or SIGHUP. */
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => controller.abort(signal))
}

/** Writes an interrupted result, then re-raises the signal for a 128 + N exit status. */
function exitOnSignal(signal, operationId) {
  const result = {
    ok: false,
    error: { code: 'interrupted', message: `Interrupted by ${signal}.`, retryable: false },
    next: [{ by: 'agent', command: `acme operations resume ${operationId}`, description: 'Resume the interrupted operation' }],
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.kill(process.pid, signal))
}
```

### Exit and stream hygiene

- **Set `process.exitCode`; do not call `process.exit()` after writing output.** Writes to pipes are asynchronous on POSIX ([Node docs](https://nodejs.org/api/process.html#a-note-on-process-io)). In our measurement, writing 4 MB and then calling `process.exit(1)` delivered only 65,536 bytes through a pipe.
- **Let the event loop drain.** Unref timers, close servers and database handles, and always consume or cancel `fetch` response bodies; an unconsumed body kept a process alive for 40 s in our measurement ([undici docs](https://undici.nodejs.org/#/?id=garbage-collection)).
- **Handle EPIPE.** `console.log` ignores EPIPE, but `process.stdout.write` crashes with an unhandled error when the reader (for example `head`) exits. Stop writing and exit quietly.
- **Convert crashes into results.** Catch errors at the top level and in `uncaughtException`/`unhandledRejection` handlers, emit an `internal_error` result in machine mode, and exit `1`.

```js
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

/** Writes the final machine-mode result and sets the exit code. */
function emitResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
```

## Survey

### Patterns worth borrowing

| Reference | Observed behavior | Takeaway |
| --- | --- | --- |
| [Cloudflare `cf`](https://blog.cloudflare.com/cf-cli-local-explorer) ([source](https://github.com/cloudflare/cf)) | One schema generates commands and docs; JSON on stdout; `schema` discovery and MCP tool export; `--dry-run` on generated commands; agent detection changes help | Single source of truth for parser, help, and schemas |
| [Vercel CLI](https://vercel.com/docs/cli/agent) | Agent detection enables noninteractive mode; JSON errors on stdout with `status`, `reason`, `next`, `userActionRequired` | Structured next steps and action-required results |
| [Google Workspace CLI](https://github.com/googleworkspace/cli) | Runtime `schema` discovery, raw JSON input, dry runs, packaged skills, JSON errors on stdout | Discoverable inputs; skills shipped with the CLI |
| [GitHub CLI](https://cli.github.com/manual/gh_help_formatting) | `--json <fields>` selection with `--jq`; full help on usage errors for detected agents; empty results exit `0` | Field selection; agent-aware usage errors |
| [Railway CLI](https://github.com/railwayapp/cli) | Errors as `{error, code, hint}` on stdout, so agents can always parse stdout | JSON on stdout in every outcome |
| [Pulumi](https://github.com/pulumi/pulumi) | Exit codes declared a contract for automation; stable `pulumi.cloud_api.*` error codes with suggestions | Stable error codes with suggested fixes |
| [CLI Guidelines](https://clig.dev/) | Composable streams, JSON mode, terminal-aware presentation | Treat stdout as an API; keep interactive presentation optional |
| [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents) | Task-oriented tools, compact responses, actionable errors, evaluations | Fewer, higher-level commands; evaluate with real tasks |

### Exit codes in practice

| CLI | Codes | Where detail lives |
| --- | --- | --- |
| Cloudflare `cf` | `0`, `1`, `130` prompt cancel, child codes passed through | Human error box on stderr |
| GitHub CLI | `0`, `1`, `2` cancelled, `4` no credentials, `8` `pr checks` pending | stderr text |
| Vercel | `0`, `1` (nearly all errors), `2` usage | JSON `reason` (about 50 values) on stdout |
| Google Workspace CLI | `1` API, `2` auth, `3` validation, `4` discovery, `5` other | JSON `{error: {code, message, reason}}` on stdout |
| Pulumi | `2`–`9` and `255`, several not yet wired | JSON codes with suggestions |
| AWS CLI v2 | `0`, `1`, `2`, `130`, `252`–`255` | stderr text |
| Gemini CLI | `0`, `1`, `41`–`55`, `130` (docs list four) | JSON `{type, message, code}` |
| Stripe, Netlify, Supabase, Neon, kubectl, gcloud, Codex | `0`/`1` | Varies |

Codes to avoid in any case: `2` (Bash builtin misuse; Claude Code hook block), `124` (GNU `timeout`), `126`–`127` (shell: not executable, not found), `128`–`255` (signals). flyctl uses `126`/`127` for timeout/cancel and Wrangler Pages uses `156`–`159`, both colliding with shell meanings.
