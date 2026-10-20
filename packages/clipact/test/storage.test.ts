import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import * as z from 'zod'
import type { Env } from '../src/agent.ts'
import {
  type Command,
  defineCli,
  defineCommand,
  defineHandler,
  defineStore,
} from '../src/index.ts'
import { defaultDir, resolveDir } from '../src/storage.ts'
import { assertContract, invoke } from '../src/testing.ts'

const store = defineStore({
  schema: z.object({
    network: z.enum(['mainnet', 'calibration']).optional(),
    sessions: z.record(z.string(), z.string()).default({}),
  }),
})

const whereInput = z.object({ peek: z.boolean().default(false) })

/** Returns the CLI's folder, created unless `--peek` is given. */
const where: Command<typeof whereInput, undefined> = defineCommand({
  name: 'where',
  description: "Print the CLI's folder",
  input: whereInput,
  errors: ['state_unwritable'],
  readOnly: true,
  handler: async () => ({
    default: defineHandler(where, async (ctx) =>
      ctx.ok({ dir: await ctx.dir({ create: !ctx.input.peek }) })
    ),
  }),
})

const saveInput = z.object({ network: z.enum(['mainnet', 'calibration']) })

/** Saves the network in the store. */
const save: Command<typeof saveInput, undefined> = defineCommand({
  name: 'save',
  description: 'Save the network',
  input: saveInput,
  errors: ['state_unwritable', 'config_invalid'],
  idempotent: true,
  handler: async () => ({
    default: defineHandler(save, async (ctx) => {
      const conf = await store.get(ctx)
      conf.set('network', ctx.input.network)
      return ctx.ok({ network: conf.get('network') })
    }),
  }),
})

/** Reads the network from the store. */
const show: Command<undefined, undefined> = defineCommand({
  name: 'show',
  description: 'Show the network',
  errors: ['config_invalid'],
  readOnly: true,
  handler: async () => ({
    default: defineHandler(show, async (ctx) => {
      const conf = await store.get(ctx)
      return ctx.ok({ network: conf.get('network') ?? null })
    }),
  }),
})

const cli = defineCli({
  name: 'acme',
  version: '1.0.0',
  commands: [where, save, show],
  store,
})

let home = ''
let env: Env = {}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clipact-storage-'))
  env = { HOME: home, XDG_DATA_HOME: join(home, 'data') }
})

/** The CLI's default folder under the test home directory. */
function dir(): string {
  return defaultDir('acme', env) as string
}

/** Runs the CLI with the test environment and returns its checked result. */
async function run(args: string[], vars: Env = {}) {
  const result = await invoke(cli, args, { env: { ...env, ...vars } })
  return assertContract(result)
}

describe('folder resolution', () => {
  test('follows each platform', () => {
    assert.equal(
      defaultDir('acme', { HOME: '/h' }, 'darwin'),
      '/h/Library/Application Support/acme'
    )
    assert.equal(
      defaultDir('acme', { HOME: '/h' }, 'linux'),
      '/h/.local/share/acme'
    )
    assert.equal(
      defaultDir('acme', { HOME: '/h', XDG_DATA_HOME: '/x' }, 'linux'),
      '/x/acme'
    )
    assert.equal(
      defaultDir('acme', { HOME: '/h', XDG_DATA_HOME: 'relative' }, 'linux'),
      '/h/.local/share/acme'
    )
    assert.equal(
      defaultDir(
        'acme',
        { LOCALAPPDATA: 'C:\\Users\\h\\AppData\\Local' },
        'win32'
      ),
      join('C:\\Users\\h\\AppData\\Local', 'acme')
    )
  })

  test('reads XDG_DATA_HOME on Linux only', () => {
    assert.equal(
      defaultDir('acme', { HOME: '/h', XDG_DATA_HOME: '/x' }, 'darwin'),
      '/h/Library/Application Support/acme'
    )
  })

  test('is undefined without a home folder', () => {
    assert.equal(defaultDir('acme', {}, 'linux'), undefined)
    assert.equal(defaultDir('acme', {}, 'darwin'), undefined)
    assert.equal(defaultDir('acme', { HOME: '/h' }, 'win32'), undefined)
  })

  test('<PREFIX>_CONFIG_DIR wins, and an empty value counts as unset', () => {
    assert.deepEqual(
      resolveDir(
        'acme',
        'ACME_CONFIG_DIR',
        { HOME: '/h', ACME_CONFIG_DIR: '/c' },
        'linux'
      ),
      { dir: '/c', issues: [] }
    )
    assert.deepEqual(
      resolveDir(
        'acme',
        'ACME_CONFIG_DIR',
        { HOME: '/h', ACME_CONFIG_DIR: '' },
        'linux'
      ),
      { dir: '/h/.local/share/acme', issues: [] }
    )
  })

  test('a relative <PREFIX>_CONFIG_DIR is invalid_input', async () => {
    const result = await invoke(cli, ['where', '--json'], {
      env: { ...env, ACME_CONFIG_DIR: 'relative' },
    })
    const error = assertContract(result).error as {
      code: string
      details: { path: string }[]
    }
    assert.equal(error.code, 'invalid_input')
    assert.equal(error.details[0]?.path, 'ACME_CONFIG_DIR')
    const help = await invoke(cli, ['--help'], {
      env: { ...env, ACME_CONFIG_DIR: 'relative' },
    })
    assert.equal(help.exitCode, 0)
  })

  test('root help lists <PREFIX>_CONFIG_DIR', async () => {
    const help = await invoke(cli, ['--help'], { env, tty: true })
    assert.match(
      help.stdout,
      / {2}ACME_CONFIG_DIR +Absolute path of this CLI's folder/
    )
  })
})

describe('ctx.dir()', () => {
  test('creates the folder with mode 0700', async () => {
    const result = await run(['where', '--json'])
    assert.deepEqual(result.data, { dir: dir() })
    const info = await stat(dir())
    assert.ok(info.isDirectory())
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o700)
    }
  })

  test('returns the path without creating it when create is false', async () => {
    const result = await run(['where', '--peek', '--json'])
    assert.deepEqual(result.data, { dir: dir() })
    await assert.rejects(stat(dir()), { code: 'ENOENT' })
  })

  test('uses <PREFIX>_CONFIG_DIR', async () => {
    const custom = join(home, 'custom', 'nested')
    const result = await run(['where', '--json'], { ACME_CONFIG_DIR: custom })
    assert.deepEqual(result.data, { dir: custom })
    assert.ok((await stat(custom)).isDirectory())
  })

  test('is state_unwritable without a home folder', async () => {
    const result = assertContract(await invoke(cli, ['where', '--json'], {}))
    assert.equal((result.error as { code: string }).code, 'state_unwritable')
  })

  test('is state_unwritable when the folder cannot be created', async () => {
    if (process.platform === 'win32') {
      return
    }
    const locked = join(home, 'locked')
    await mkdir(locked, { mode: 0o500 })
    try {
      const result = await run(['where', '--json'], {
        ACME_CONFIG_DIR: join(locked, 'acme'),
      })
      const error = result.error as { code: string; details: { path: string } }
      assert.equal(error.code, 'state_unwritable')
      assert.equal(error.details.path, join(locked, 'acme'))
    } finally {
      await chmod(locked, 0o700)
    }
  })
})

describe('defineStore', () => {
  test('saves to config.json in the CLI folder and reads it back', async () => {
    const saved = await run(['save', '--network', 'mainnet', '--json'])
    assert.deepEqual(saved.data, { network: 'mainnet' })
    const shown = await run(['show', '--json'])
    assert.deepEqual(shown.data, { network: 'mainnet' })
    const file = JSON.parse(await readFile(join(dir(), 'config.json'), 'utf8'))
    assert.equal(file.network, 'mainnet')
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dir(), 'config.json'))).mode & 0o777, 0o600)
    }
  })

  test('reading writes no file', async () => {
    const shown = await run(['show', '--json'])
    assert.deepEqual(shown.data, { network: null })
    await assert.rejects(stat(join(dir(), 'config.json')), { code: 'ENOENT' })
  })

  test('a corrupt file is config_invalid with its path', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'config.json'), '{not json')
    const result = await run(['show', '--json'])
    const error = result.error as { code: string; details: { path: string } }
    assert.equal(error.code, 'config_invalid')
    assert.equal(error.details.path, join(dir(), 'config.json'))
  })

  test('a schema violation is config_invalid', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(
      join(dir(), 'config.json'),
      JSON.stringify({ network: 'moon' })
    )
    const result = await run(['show', '--json'])
    assert.equal((result.error as { code: string }).code, 'config_invalid')
  })

  test('a write in a read-only folder is state_unwritable', async () => {
    if (process.platform === 'win32') {
      return
    }
    await mkdir(dir(), { recursive: true })
    await chmod(dir(), 0o500)
    try {
      const result = await run(['save', '--network', 'mainnet', '--json'])
      const error = result.error as { code: string; details: { path: string } }
      assert.equal(error.code, 'state_unwritable')
      assert.ok(error.details.path.startsWith(dir()))
    } finally {
      await chmod(dir(), 0o700)
    }
  })

  test('keeps clipact.json apart from the store', async () => {
    const telemetry = defineCli({
      ...cli.options,
      telemetry: {
        sender: new URL('./fixtures/telemetry-sender.ts', import.meta.url),
      },
    })
    await invoke(telemetry, ['telemetry', 'disable'], { env })
    await invoke(telemetry, ['save', '--network', 'calibration'], { env })
    assert.deepEqual(
      JSON.parse(await readFile(join(dir(), 'clipact.json'), 'utf8')),
      { telemetry: 'disabled' }
    )
    const config = JSON.parse(
      await readFile(join(dir(), 'config.json'), 'utf8')
    )
    assert.equal(config.network, 'calibration')
    assert.equal('telemetry' in config, false)
  })

  test('the name clipact is reserved in any case', () => {
    for (const name of ['clipact', 'Clipact', 'CLIPACT']) {
      assert.throws(
        () => defineStore({ schema: z.object({}), name }),
        new RegExp(`Store name "${name}" is reserved for clipact`)
      )
    }
  })

  test('store.get() needs a CLI defined with the store', async () => {
    const other = defineCli({
      name: 'acme',
      version: '1.0.0',
      commands: [show],
    })
    const result = await invoke(other, ['show', '--json'], {
      env,
      strict: false,
    })
    assert.equal(
      (result.json?.error as { code: string } | undefined)?.code,
      'internal_error'
    )
  })
})
