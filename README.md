# agents

Tools for building software that coding agents use. This repository holds `clipact`, a framework for Node.js CLIs that agents run, a Vite plugin that publishes Agent Skills, and the guidelines behind them. It is a pnpm and Turborepo monorepo. The packages publish to npm, and the examples stay private.

The packages moved here from [hugomrdias/fil](https://github.com/hugomrdias/fil), where the `fil` CLI and fil-app still use them. The history before the move keeps that repository's pull request numbers, written as `hugomrdias/fil#<number>`.

## Packages and examples

| Directory | npm | Contents |
| --- | --- | --- |
| [`packages/clipact`](packages/clipact/README.md) | `clipact` | A framework for Node.js CLIs that agents run. Each command writes one JSON result with stable error codes and `next` steps. |
| [`packages/vite-plugin-agent-skills`](packages/vite-plugin-agent-skills/README.md) | `@hugomrdias/vite-plugin-agent-skills` | A Vite plugin that publishes Agent Skills under `/.well-known/agent-skills/` for agent skills discovery. |
| [`examples/launchpad`](examples/launchpad/README.md) | Private | A complete clipact CLI that deploys sites to a mock host, with an esbuild bundle. |

## Documentation

| Document | Contents |
| --- | --- |
| [Agent-facing CLIs](docs/agent-cli/README.md) | Guidelines for Node.js CLIs that agents run, and the design of clipact |

## Build and check

Use Node.js 24 or newer and pnpm 11.24.0, which provisions the configured Node.js 24 runtime. Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm check` runs TypeScript, tests, and Biome in every workspace through Turborepo, then lints the root configuration. `pnpm check:fix` applies Biome fixes.

## Release

[release-please](https://github.com/googleapis/release-please) versions the packages from [Conventional Commits](https://www.conventionalcommits.org/). [`.github/release-please-config.json`](.github/release-please-config.json) lists them, and [`.github/.release-please-manifest.json`](.github/.release-please-manifest.json) holds their current versions. The examples are not released.

1. On each push to `main`, the [Release workflow](.github/workflows/release.yml) opens or updates one release pull request per package, because `separate-pull-requests` is on. Each pull request bumps the version and updates `CHANGELOG.md` of a package that a commit touched since its last release. Below 1.0.0, `feat` bumps the minor version and `fix` the patch version. Until a package has a release in this repository, `bootstrap-sha` starts its commit range at the move from hugomrdias/fil, so the changelog does not repeat the earlier releases.
2. Merging a release pull request tags the release as `<component>-v<version>`, such as `clipact-v0.5.0`, and creates its GitHub release. You can merge the pull requests in any order.
3. The same workflow then publishes each released package with `pnpm publish`, which replaces `workspace:` and `catalog:` specifiers, and adds provenance.

The workflow publishes through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so the repository holds no npm token. Each package needs a trusted publisher on npmjs.com for the `hugomrdias/agents` repository and the `release.yml` workflow. The publish job runs in the `npm` GitHub environment, which GitHub creates on the first run. Naming `npm` as the trusted publisher's optional environment limits publishing to that job. Pull requests that `GITHUB_TOKEN` opens do not trigger CI, so set a `RELEASE_PLEASE_TOKEN` secret with a token that can open pull requests to run CI on the release pull requests.
