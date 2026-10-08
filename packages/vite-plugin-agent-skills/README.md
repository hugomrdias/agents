# vite-plugin-agent-skills

A Vite plugin that publishes [Agent Skills](https://agentskills.io/specification) for [agent skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc). It reads a directory of skills, validates them, and writes the discovery index and each skill's file under `.well-known/agent-skills/` in the build output. Any static host can serve them, and agents install them with `npx skills add https://your.site`.

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { agentSkills } from 'vite-plugin-agent-skills'

export default defineConfig({
  plugins: [agentSkills({ dir: 'skills' })],
})
```

Each skill is a directory with a `SKILL.md` whose YAML frontmatter has a `name`, equal to the directory name, and a `description`:

```text
skills/
├── fil/
│   └── SKILL.md
└── deploy/
    ├── SKILL.md
    └── references/guide.md
```

The build writes:

| Output path | Contents |
| --- | --- |
| `.well-known/agent-skills/index.json` | The discovery index, v0.2.0, with each skill's type and SHA-256 digest. URLs are relative to the index |
| `.well-known/agent-skills/<name>/SKILL.md` | A skill that has only `SKILL.md`, listed as `skill-md` |
| `.well-known/agent-skills/<name>.tar.gz` | A skill with more files, listed as `archive` |

The dev server serves the same paths, answers `404` for any other path under the prefix, and picks up added, changed, and deleted skills without a restart.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `dir` | Required | Directory with one directory per skill |
| `base` | Site root | Path under Vite's `base` where `.well-known/agent-skills/` goes, such as `docs/`. Clients look for the index under the URL they are given first, then at the origin's root |
| `environment` | `client` | Vite environment whose build output gets the files. In an SSR app, this is the output the host serves as static files |

## Validation

The build fails with a list of every problem when a skill:

- has no `SKILL.md`, or its frontmatter is missing or not a YAML mapping;
- has a `name` that differs from its directory name, or a directory name the specification does not allow;
- has no `description`, or one longer than 1,024 characters;
- contains a symbolic link or another special file;
- has more than 1,000 files or 50 MiB, the limits of the `skills` CLI.

## Archives

The plugin packs the same `.tar.gz` bytes on every build, so a skill's digest changes only when the skill does. Entries are sorted, timestamps are zero, owners are empty, each file keeps only its executable bit, and the gzip header names no operating system. Compression uses Node.js's zlib, so a Node.js release that changes zlib's output gives every archive a new digest.

## Headers

Static hosts choose the response headers. Set these for the files under `.well-known/agent-skills/`:

- `Access-Control-Allow-Origin: *`, so browser agents can fetch them.
- A short `Cache-Control`, because the files keep their names when they change.
- `Content-Type: text/markdown; charset=utf-8` for `SKILL.md` and `application/gzip` for `.tar.gz`, if the host does not already.

On Cloudflare Workers static assets or Pages, add a `_headers` file to Vite's `public/` directory:

```text
/.well-known/agent-skills/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300

/.well-known/agent-skills/*/SKILL.md
  Content-Type: text/markdown; charset=utf-8
```

## Virtual module

`virtual:agent-skills` exports the index and each skill's site path, for app code such as an `llms.txt` route. It does not contain the files' bytes.

```ts
import { index, skills } from 'virtual:agent-skills'

skills[0].path // '/.well-known/agent-skills/fil/SKILL.md'
```

For its types, add `vite-plugin-agent-skills/client` to `types` in `tsconfig.json`, or reference it from a declaration file:

```ts
/// <reference types="vite-plugin-agent-skills/client" />
```

## API

The package also exports the functions the plugin uses: `publishSkills(dir)` validates a skills directory and builds each file, `discoveryIndex(skills)` builds the index, `parseFrontmatter(markdown)` reads a `SKILL.md` frontmatter, and `tarGz(files)` packs an archive.

## Not supported

- `.zip` archives. The RFC lets servers choose `.tar.gz` or `.zip`, and clients must accept both.
- The legacy v0.1 index at `/.well-known/skills/index.json`.
