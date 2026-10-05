import { defineHandler } from '../../src/index.ts'
import { ls } from './commands.ts'

export default defineHandler(ls, (ctx) => ctx.ok([{ id: 'a1' }, { id: 'a2' }]))
