/**
 * Vite plugin that publishes Agent Skills for agent skills discovery. It
 * reads a directory of skills, validates them, and writes the discovery index
 * and each skill's file under `.well-known/agent-skills/` in the build output,
 * so any static host serves them. The dev server serves the same files, and
 * the `virtual:agent-skills` module exposes the index to app code.
 *
 * @see https://github.com/cloudflare/agent-skills-discovery-rfc
 * @see https://agentskills.io/specification
 */
import { resolve, sep } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import {
  type DiscoveryIndex,
  discoveryIndex,
  type PublishedSkill,
  publishSkills,
} from './skills.ts'

export {
  DISCOVERY_SCHEMA,
  type DiscoveryEntry,
  type DiscoveryIndex,
  discoveryIndex,
  type PublishedSkill,
  parseFrontmatter,
  publishSkills,
} from './skills.ts'
export { type TarFile, tarGz } from './tar.ts'

/** Options of {@link agentSkills}. */
export interface AgentSkillsOptions {
  /** Directory that holds one directory per skill, each with a `SKILL.md`. */
  dir: string
  /**
   * Path under Vite's `base` where `.well-known/agent-skills/` goes, such as
   * `docs/`. Defaults to the site root. Clients look for the index under the
   * URL they are given first, then at the origin's root.
   */
  base?: string
  /** Vite environment whose build output gets the files. Defaults to `client`. */
  environment?: string
}

/** A published skill as the `virtual:agent-skills` module lists it. */
export interface SkillSummary {
  name: string
  description: string
  type: PublishedSkill['type']
  digest: string
  /** Site path of the published file, such as `/.well-known/agent-skills/fil/SKILL.md`. */
  path: string
}

/** Skills and index built from the skills directory. */
interface Publication {
  skills: PublishedSkill[]
  index: DiscoveryIndex
  files: string[]
}

const VIRTUAL_ID = 'virtual:agent-skills'
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const WELL_KNOWN = '.well-known/agent-skills/'

/**
 * Publish the Agent Skills in `options.dir` under `.well-known/agent-skills/`.
 *
 * @param options - Plugin options.
 */
export function agentSkills(options: AgentSkillsOptions): Plugin {
  const dir = resolve(options.dir)
  const base = normalizeBase(options.base ?? '')
  const environment = options.environment ?? 'client'
  let sitePath = `/${base}${WELL_KNOWN}`
  let publication: Promise<Publication> | undefined

  const publish = () => {
    publication ??= publishSkills(dir).then(({ skills, files }) => ({
      skills,
      files,
      index: discoveryIndex(skills),
    }))
    return publication
  }

  return {
    name: 'agent-skills',
    enforce: 'pre',
    configResolved(config) {
      // A relative or absolute-URL `base` has no fixed site path; use the root.
      const viteBase = config.base.startsWith('/') ? config.base : '/'
      sitePath = `${viteBase}${base}${WELL_KNOWN}`
    },
    buildStart() {
      publication = undefined
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined
    },
    async load(id) {
      if (id !== RESOLVED_ID) {
        return undefined
      }
      const { skills, index, files } = await publish()
      for (const file of files) {
        this.addWatchFile(file)
      }
      const summaries: SkillSummary[] = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        type: skill.type,
        digest: skill.digest,
        path: `${sitePath}${skill.file}`,
      }))
      return [
        `export const index = ${JSON.stringify(index)}`,
        `export const skills = ${JSON.stringify(summaries)}`,
      ].join('\n')
    },
    async generateBundle() {
      if (this.environment.name !== environment) {
        return
      }
      const { skills, index } = await publish()
      this.emitFile({
        type: 'asset',
        fileName: `${base}${WELL_KNOWN}index.json`,
        source: `${JSON.stringify(index, null, 2)}\n`,
      })
      for (const skill of skills) {
        this.emitFile({
          type: 'asset',
          fileName: `${base}${WELL_KNOWN}${skill.file}`,
          source: skill.bytes,
        })
      }
    },
    configureServer(server) {
      server.watcher.add(dir)
      const reload = (file: string) => {
        if (file === dir || file.startsWith(`${dir}${sep}`)) {
          publication = undefined
          invalidate(server)
        }
      }
      server.watcher.on('add', reload)
      server.watcher.on('change', reload)
      server.watcher.on('unlink', reload)
      server.watcher.on('unlinkDir', reload)

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        if (
          (req.method !== 'GET' && req.method !== 'HEAD') ||
          !pathname.startsWith(sitePath)
        ) {
          return next()
        }
        try {
          const file = servedFile(
            await publish(),
            pathname.slice(sitePath.length)
          )
          // The plugin owns this prefix: a missing file is a 404, not the
          // app's HTML fallback.
          if (file === undefined) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': file.contentType,
            'Content-Length': file.bytes.length,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          })
          res.end(req.method === 'HEAD' ? undefined : file.bytes)
        } catch (error) {
          next(error)
        }
      })
    },
  }
}

/**
 * The bytes and content type served at a path under the well-known prefix.
 *
 * @param publication - Published skills and index.
 * @param file - Path relative to `.well-known/agent-skills/`.
 */
function servedFile(publication: Publication, file: string) {
  if (file === 'index.json') {
    return {
      contentType: 'application/json',
      bytes: new TextEncoder().encode(
        `${JSON.stringify(publication.index, null, 2)}\n`
      ),
    }
  }
  return publication.skills.find((skill) => skill.file === file)
}

/**
 * Drop the virtual module from every environment and reload the page, so
 * the next request rebuilds the skills.
 *
 * @param server - Vite dev server.
 */
function invalidate(server: ViteDevServer) {
  for (const environment of Object.values(server.environments)) {
    const module = environment.moduleGraph.getModuleById(RESOLVED_ID)
    if (module) {
      environment.moduleGraph.invalidateModule(module)
    }
  }
  server.ws.send({ type: 'full-reload' })
}

/**
 * Turn the `base` option into a path with no leading slash and one trailing
 * slash, or an empty string for the root.
 *
 * @param base - The `base` option.
 */
function normalizeBase(base: string) {
  const trimmed = base.replace(/^\/+|\/+$/g, '')
  if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(
      `agentSkills: base must not contain . or .. segments: ${base}`
    )
  }
  return trimmed === '' ? '' : `${trimmed}/`
}
