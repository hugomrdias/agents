# launchpad (clipact example)

A complete CLI built with [clipact](../../packages/clipact/README.md): `launchpad` deploys static sites to a **mock** hosting service. Nothing leaves your machine; the mock SDK keeps state in a JSON file so separate commands see each other's changes.

It shows every framework feature in a realistic shape, plus the release setup: an esbuild bundle with lazy handler chunks and an entry shim that enables Node's compile cache.

## Try it

```sh
pnpm install
pnpm --filter clipact build
pnpm --filter launchpad-example build
cd examples/launchpad

export LAUNCHPAD_TOKEN=lp_demo     # any token starting with lp_
node bin/launchpad.js --help
node bin/launchpad.js sites create my-blog --region eu --format human
node bin/launchpad.js deploy my-blog ./src --dry-run
node bin/launchpad.js deploy my-blog ./src
node bin/launchpad.js sites domains add my-blog blog.example shop.com
node bin/launchpad.js schema deploys create
AI_AGENT=demo node bin/launchpad.js sites delete my-blog
```

Mock knobs, read only by the fake SDK: `LAUNCHPAD_HOME` (state directory, default `<tmpdir>/launchpad-example`), `LAUNCHPAD_MOCK_LATENCY_MS` (delay per uploaded file, default 150), and `LAUNCHPAD_MOCK_RATE_LIMIT=1` (every `sites list` is rate limited).

## Commands

| Command | Shows |
| --- | --- |
| `sites list` (alias `ls`) | `readOnly`; `--limit` with min/max and default; cursor pagination with `nextCursor` and a `next` step; a table `human` formatter; transient `rate_limited` that becomes retryable automatically |
| `sites get <site>` | Required positional; `not_found` from `mapError` with an agent `next` step |
| `sites create <name>` | Regex validation with a custom message; enum flags with defaults; `region` falling back to `LAUNCHPAD_REGION`; an object field (`--meta '{"owner":"web"}'`); the whole request from `--input -`; `conflict` from `mapError` |
| `sites delete <site>` | Static `confirm`; `--yes`; `--dry-run` returning the same shape without side effects |
| `sites domains add <site> <domains...>` | A nested group; a variadic positional; `idempotent`; a failure with partial data (`domains`) and both `user` and `agent` next steps |
| `deploys create <site> <paths...>` (alias `deploy`) | Conditional `confirm` (only with `--prod`); `--dry-run`; a boolean flag; `ctx.log`, `ctx.progress`, and `ctx.checkpoint`; `ctx.signal` passed to the SDK; `file_not_found` listing every missing path |
| `deploys status <deployment>` | A `next` step that depends on state |
| `deploys resume <deployment>` | Finishing an interrupted deployment from its persisted record |
| `whoami` | `ctx.mode`: detected agent, format, and interactivity |

Every API command shares the `token` and `team` fields from [`src/commands/shared.ts`](src/commands/shared.ts): `token` is a secret read only from `LAUNCHPAD_TOKEN`, and `team` falls back to `LAUNCHPAD_TEAM`. There are no global options or middleware; [`src/handlers/client.ts`](src/handlers/client.ts) is a plain function each handler calls.

## What to look at

**Interrupt and resume.** Each file is recorded as it uploads, and the deployment ID is printed before the first upload:

```sh
$ LAUNCHPAD_MOCK_LATENCY_MS=2000 node bin/launchpad.js deploy my-blog ./src --json
Deploying 20 files to my-blog
launchpad: started dpl_2; if interrupted, run: launchpad deploys resume dpl_2
launchpad: upload: 1/20 cli.ts
^C
launchpad: Interrupted by SIGINT.
{"ok":false,"error":{"code":"interrupted","message":"Interrupted by SIGINT.","retryable":false},"next":[{"by":"agent","command":"launchpad deploys resume dpl_2","description":"Upload the remaining files of this deployment"}]}
$ echo $?
130
$ node bin/launchpad.js deploys resume dpl_2 --format human
Deployed 20 files to https://dpl_2--my-blog.launchpad.example
```

Without `--json`, a terminal gets human output: a rewritten status line while uploading, and the error and next steps on stderr.

**Partial results that need a human.** Attaching `shop.com` succeeds, but the domain cannot serve traffic until someone adds a DNS record, so `ok` is `false`. The result still includes the attached domains:

```json
{"ok":false,"error":{"code":"verification_pending","message":"1 domain(s) need a DNS TXT record before they serve traffic.","retryable":false},"domains":[{"name":"blog.example","verified":true,"txtRecord":"launchpad-verify=site_1"},{"name":"shop.com","verified":false,"txtRecord":"launchpad-verify=site_1"}],"next":[{"by":"user","description":"Add a TXT record on shop.com with the value \"launchpad-verify=site_1\""},{"by":"agent","command":"launchpad sites domains add my-blog shop.com","description":"Recheck verification after the DNS change (safe to repeat)"}]}
```

**Confirmation for agents.** Without a human at the terminal, a production deploy stops and hands the decision to the user:

```json
{"ok":false,"error":{"code":"confirmation_required","message":"Replaces the live production site \"my-blog\". Confirm with --yes.","retryable":false,"details":{"reason":"Replaces the live production site \"my-blog\"."}},"next":[{"by":"user","command":"launchpad deploys create my-blog ./dist --prod --yes","description":"Approve this action, then run it with --yes"}]}
```

**Error mapping.** [`src/map-error.ts`](src/map-error.ts) is imported only when a handler throws an SDK error, so `--help` and `schema` never load the SDK.

## Layout

```text
bin/launchpad.js          entry shim: enableCompileCache, then import('../dist/main.js')
scripts/build.ts          esbuild: one ESM entry plus a chunk per handler
scripts/bench.ts          startup timing against node -e ''
src/main.ts               cli.run()
src/cli.ts                defineCli: commands, aliases, envPrefix, mapError
src/commands/*.ts         definitions only (zod + clipact)
src/handlers/**           handlers, loaded lazily per command
src/map-error.ts          SDK errors → CLI error codes
src/sdk/client.ts         the mock hosting API
test/launchpad.test.ts    in-process tests with invoke, and real-process tests of the bundle with exec
test/contract.test.ts     output-contract sweep and module-load tracing against the bundle
```

## Bundling and startup

[`scripts/build.ts`](scripts/build.ts) bundles `src/main.ts` with esbuild (`bundle`, `splitting`, `format: 'esm'`, `minify`, `target: 'node24'`). The entry chunk holds clipact, zod, and every definition; each handler, the SDK, and `map-error` are separate chunks that load only when needed. `clipact` and `zod` are devDependencies because the published package would contain only `bin/` and `dist/`.

[`bin/launchpad.js`](bin/launchpad.js) calls `module.enableCompileCache()` before dynamically importing the bundle. A statically imported module would be compiled before the cache is enabled.

`pnpm bench` after `pnpm build`, on Node.js v26.10.0 (Apple Silicon, warm cache, median of 25 runs):

| Command | Time | Over `node -e ''` |
| --- | --- | --- |
| `node -e ''` | 59.6 ms | |
| `--version` | 70.4 ms | +10.8 ms |
| `--help` | 73.2 ms | +13.6 ms |
| `schema sites create` | 74.0 ms | +14.4 ms |
| `sites list` (loads a handler and the SDK) | 73.0 ms | +13.4 ms |

`--version` slightly exceeds the design's 10 ms budget, because the entry chunk loads zod and every definition before routing. A CLI that needs less can precompute help and schema output at build time, as the [design](../../docs/cli-framework-design.md#performance-budget) describes.

## Tests

```sh
pnpm --filter launchpad-example test
```

Tests build first (Turborepo runs `build` before `test`). In-process tests use `invoke`, which also checks every output against its schema and every error code against the command's `errors`. Real-process tests run the bundle with `exec`, including a SIGTERM during an upload followed by `deploys resume`.

[`test/contract.test.ts`](test/contract.test.ts) validates the framework through this example: it runs the built binary through 36 valid and invalid invocations and checks the output contract on each (one JSON line, exit code matching `ok`, no ANSI codes, no JSON on stderr, a stderr summary on failure, the token never printed). It also traces module loading to prove that `--help`, `--version`, and `schema` load only the entry chunks, never a handler or the SDK.
