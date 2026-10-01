import { CliError, defineHandler } from 'clipact'
import { addDomains } from '../../commands/sites.ts'
import { client } from '../client.ts'

export default defineHandler(addDomains, async (ctx) => {
  const api = await client(ctx.input, ctx.signal)
  const domains = []
  for (const name of ctx.input.domains) {
    domains.push(await api.addDomain(ctx.input.site, name))
  }
  const pending = domains.filter((domain) => !domain.verified)
  if (pending.length > 0) {
    // Partial result: the domains are attached, but the command's promise
    // (working custom domains) needs a human to change DNS first.
    throw new CliError({
      code: 'verification_pending',
      message: `${pending.length} domain(s) need a DNS TXT record before they serve traffic.`,
      data: { domains },
      next: [
        ...pending.map((domain) => ({
          by: 'user' as const,
          description: `Add a TXT record on ${domain.name} with the value "${domain.txtRecord}"`,
        })),
        {
          by: 'agent',
          command: `launchpad sites domains add ${ctx.input.site} ${pending.map((domain) => domain.name).join(' ')}`,
          description:
            'Recheck verification after the DNS change (safe to repeat)',
        },
      ],
    })
  }
  return ctx.ok({ domains })
})
