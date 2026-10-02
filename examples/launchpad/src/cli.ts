import { defineCli } from 'clipact'
import pkg from '../package.json' with { type: 'json' }
import { deploys } from './commands/deploys.ts'
import { sites } from './commands/sites.ts'
import { whoami } from './commands/whoami.ts'

/** The launchpad CLI: definitions only, no handlers or SDK imported. */
export const cli = defineCli({
  name: 'launchpad',
  version: pkg.version,
  description: 'Deploy static sites (example clipact CLI with a mock backend)',
  envPrefix: 'LAUNCHPAD',
  commands: [sites, deploys, whoami],
  aliases: { deploy: 'deploys create', ls: 'sites list' },
  skills: new URL('../skills/', import.meta.url),
  mapError: () => import('./map-error.ts'),
})
