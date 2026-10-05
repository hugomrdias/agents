---
name: launchpad
description: Deploy static sites with the launchpad CLI, check deployments, and resume interrupted ones. Use when the user asks to create a site, deploy files, attach domains, or check a deployment.
---

# launchpad

`launchpad` deploys static sites. Every command writes one JSON object to stdout when run by an agent; it has `data` on success or `error` on failure. Branch on `error.code`, never on stderr text.

## Discover before you call

- `launchpad schema --list` lists every command with its side effects.
- `launchpad schema <command>` gives the input JSON Schema, the JSON Schema of `data`, and what each error code means, for the installed version. Prefer it over guessing flags.

## Workflow

1. `launchpad sites list` or `launchpad sites get <site>` to find the site; `launchpad sites create <name>` if it does not exist.
2. `launchpad deploy <site> <paths...> --dry-run` to see what would be uploaded, then run it without `--dry-run`.
3. Return the `url` from the result's `data` to the user exactly as given.

## Rules

- The token comes only from `LAUNCHPAD_TOKEN`. Never ask the user to paste it, and never pass it as a flag.
- `confirmation_required` means a human must approve: relay the reason and rerun with `--yes` only after they agree. `--prod` deploys and `sites delete` always need it.
- Relay every `next` step with `by: "user"` to the user and stop. Run `by: "agent"` steps yourself.
- If a deploy is interrupted, run the `launchpad deploys resume <deployment>` command from `next` instead of deploying again.
- Retry only when `error.retryable` is `true`, after `retryAfterSeconds` when present.
