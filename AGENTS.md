# agents repository instructions

## Skill Loading

- Turborepo: before changing `turbo.json`, task pipelines, or the workspace layout, load the `turborepo` skill.
- Development: read the [root README](README.md#build-and-check) when setting up the local environment or running validation.

## Changes and validation

- Use Conventional Commits: `<type>(<optional scope>): <concise imperative description>`. Scope a change to one package, such as `feat(clipact): ...`, so release-please puts it in that package's release pull request.
- Add a short JSDoc description for every new type, class, function, or method, with links to relevant references.
- After changes, run the TypeScript, Biome, and existing test checks through `pnpm check` (Turborepo). Run `pnpm build` when changing package exports or compilation settings.

## Documentation

- Keep [docs/agent-cli](docs/agent-cli/README.md) and the [clipact README](packages/clipact/README.md) current in the same change as the code.
- When code and these docs disagree, list each inconsistency for the user and let them decide which side is right before you edit either.
