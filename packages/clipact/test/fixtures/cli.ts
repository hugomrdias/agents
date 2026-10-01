import { defineCli } from '../../src/index.ts'
import { commands } from './commands.ts'

/** The fixture CLI used by the tests. */
export const cli = defineCli({
  name: 'acme',
  version: '1.2.3',
  description: 'Example publishing CLI',
  commands,
  aliases: { publish: 'artifacts put' },
  mapError: () => import('./map-error.ts'),
})
