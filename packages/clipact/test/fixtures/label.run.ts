import { defineHandler } from '../../src/index.ts'
import { label } from './commands.ts'

export default defineHandler(label, (ctx) => ctx.ok({ ...ctx.input }))
