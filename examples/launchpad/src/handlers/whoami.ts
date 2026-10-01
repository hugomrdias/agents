import { defineHandler } from 'clipact'
import { whoami } from '../commands/whoami.ts'
import { client } from './client.ts'

export default defineHandler(whoami, async (ctx) => {
  const api = await client(ctx.input, ctx.signal)
  return ctx.ok({
    team: api.team,
    agent: ctx.mode.agent,
    format: ctx.mode.format,
    interactive: ctx.mode.interactive,
  })
})
