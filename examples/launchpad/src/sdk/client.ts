/**
 * A mock hosting SDK. It stands in for a real API client: state lives in a
 * JSON file so separate CLI invocations see each other's changes, calls
 * take a configurable latency, and failures surface as SDK error classes
 * that `map-error.ts` translates into CLI error codes.
 *
 * Mock knobs (not part of the CLI contract):
 * - `LAUNCHPAD_HOME`: state directory (default: `<tmpdir>/launchpad-example`)
 * - `LAUNCHPAD_MOCK_LATENCY_MS`: delay per uploaded file (default: 150)
 * - `LAUNCHPAD_MOCK_RATE_LIMIT=1`: every list call is rate limited
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

/** A hosted site. */
export interface Site {
  id: string
  name: string
  region: 'us' | 'eu' | 'ap'
  framework: string
  meta: Record<string, string>
  createdAt: string
  domains: Domain[]
}

/** A custom domain attached to a site. */
export interface Domain {
  name: string
  verified: boolean
  /** DNS TXT record that proves ownership. */
  txtRecord: string
}

/** A file in a deployment. */
export interface DeploymentFile {
  path: string
  size: number
  uploaded: boolean
}

/** A deployment of files to a site. */
export interface Deployment {
  id: string
  siteId: string
  production: boolean
  status: 'uploading' | 'ready'
  files: DeploymentFile[]
  url: string
  createdAt: string
}

interface State {
  seq: number
  sites: Site[]
  deployments: Deployment[]
}

/** Base class of all SDK errors. */
export class SdkError extends Error {}

/** The token is missing or invalid. */
export class UnauthorizedError extends SdkError {}

/** A resource does not exist. */
export class NotFoundError extends SdkError {
  readonly resource: string

  /** Creates the error for a resource kind and ID. */
  constructor(resource: string, id: string) {
    super(`No ${resource} "${id}" exists.`)
    this.resource = resource
  }
}

/** A unique name is already taken. */
export class ConflictError extends SdkError {}

/** Too many requests; retry after a delay. */
export class RateLimitError extends SdkError {
  readonly retryAfter: number

  /** Creates the error with the server's retry delay in seconds. */
  constructor(retryAfter: number) {
    super('Too many requests.')
    this.retryAfter = retryAfter
  }
}

/** Options for {@link connect}. */
export interface ConnectOptions {
  token: string
  team: string
  signal?: AbortSignal
}

/** Returns the state file location. */
function statePath(): string {
  const home = process.env.LAUNCHPAD_HOME ?? join(tmpdir(), 'launchpad-example')
  return join(home, 'state.json')
}

/**
 * Authenticates and returns a client. Tokens must start with `lp_`.
 */
export async function connect(options: ConnectOptions): Promise<Client> {
  if (!options.token.startsWith('lp_')) {
    throw new UnauthorizedError('The API token is invalid.')
  }
  const client = new Client(options.team, options.signal)
  await client.load()
  return client
}

/** A mock API client for one team. */
export class Client {
  readonly team: string
  readonly #signal: AbortSignal | undefined
  #state: State = { seq: 0, sites: [], deployments: [] }

  /** Use {@link connect}. */
  constructor(team: string, signal?: AbortSignal) {
    this.team = team
    this.#signal = signal
  }

  /** Reads the state file. */
  async load(): Promise<void> {
    try {
      this.#state = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  /** Writes the state file atomically. */
  async #save(): Promise<void> {
    const path = statePath()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(`${path}.tmp`, JSON.stringify(this.#state, null, 2))
    await rename(`${path}.tmp`, path)
  }

  /** Returns the next ID with a prefix. */
  #id(prefix: string): string {
    this.#state.seq++
    return `${prefix}_${this.#state.seq}`
  }

  /** Lists sites, sorted by name, with cursor pagination. */
  listSites(options: { limit: number; cursor?: string }): {
    sites: Site[]
    nextCursor: string | undefined
  } {
    if (process.env.LAUNCHPAD_MOCK_RATE_LIMIT === '1') {
      throw new RateLimitError(5)
    }
    const sorted = [...this.#state.sites].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    const start = options.cursor ? Number(options.cursor) : 0
    const sites = sorted.slice(start, start + options.limit)
    const end = start + sites.length
    return { sites, nextCursor: end < sorted.length ? String(end) : undefined }
  }

  /** Finds a site by ID or name. */
  getSite(idOrName: string): Site {
    const site = this.#state.sites.find(
      (candidate) => candidate.id === idOrName || candidate.name === idOrName
    )
    if (!site) {
      throw new NotFoundError('site', idOrName)
    }
    return site
  }

  /** Creates a site with a unique name. */
  async createSite(input: {
    name: string
    region: Site['region']
    framework: string
    meta: Record<string, string>
  }): Promise<Site> {
    if (this.#state.sites.some((site) => site.name === input.name)) {
      throw new ConflictError(`The site name "${input.name}" is taken.`)
    }
    const site: Site = {
      id: this.#id('site'),
      ...input,
      createdAt: new Date().toISOString(),
      domains: [],
    }
    this.#state.sites.push(site)
    await this.#save()
    return site
  }

  /** Deletes a site and its deployments. */
  async deleteSite(idOrName: string): Promise<Site> {
    const site = this.getSite(idOrName)
    this.#state.sites = this.#state.sites.filter(
      (candidate) => candidate !== site
    )
    this.#state.deployments = this.#state.deployments.filter(
      (deployment) => deployment.siteId !== site.id
    )
    await this.#save()
    return site
  }

  /**
   * Attaches a domain. Domains under `.example` verify immediately; others
   * wait for a DNS TXT record. Adding an existing domain changes nothing.
   */
  async addDomain(idOrName: string, name: string): Promise<Domain> {
    const site = this.getSite(idOrName)
    const existing = site.domains.find((domain) => domain.name === name)
    if (existing) {
      return existing
    }
    const domain: Domain = {
      name,
      verified: name.endsWith('.example'),
      txtRecord: `launchpad-verify=${site.id}`,
    }
    site.domains.push(domain)
    await this.#save()
    return domain
  }

  /** Records a deployment before any file is uploaded. */
  async createDeployment(
    idOrName: string,
    input: { production: boolean; files: { path: string; size: number }[] }
  ): Promise<Deployment> {
    const site = this.getSite(idOrName)
    const id = this.#id('dpl')
    const deployment: Deployment = {
      id,
      siteId: site.id,
      production: input.production,
      status: 'uploading',
      files: input.files.map((file) => ({ ...file, uploaded: false })),
      url: input.production
        ? `https://${site.name}.launchpad.example`
        : `https://${id}--${site.name}.launchpad.example`,
      createdAt: new Date().toISOString(),
    }
    this.#state.deployments.push(deployment)
    await this.#save()
    return deployment
  }

  /** Finds a deployment. */
  getDeployment(id: string): Deployment {
    const deployment = this.#state.deployments.find(
      (candidate) => candidate.id === id
    )
    if (!deployment) {
      throw new NotFoundError('deployment', id)
    }
    return deployment
  }

  /** Uploads one file and records it immediately, so uploads can resume. */
  async uploadFile(id: string, path: string): Promise<void> {
    const latency = Number(process.env.LAUNCHPAD_MOCK_LATENCY_MS ?? 150)
    await setTimeout(latency, undefined, { signal: this.#signal })
    const file = this.getDeployment(id).files.find(
      (candidate) => candidate.path === path
    )
    if (file) {
      file.uploaded = true
      await this.#save()
    }
  }

  /** Marks a fully uploaded deployment as ready. */
  async finalize(id: string): Promise<Deployment> {
    const deployment = this.getDeployment(id)
    deployment.status = 'ready'
    await this.#save()
    return deployment
  }
}
