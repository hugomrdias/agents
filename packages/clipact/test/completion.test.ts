import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertContract, invoke } from '../src/testing.ts'
import { cli } from './fixtures/cli.ts'

const BIN = fileURLToPath(new URL('./fixtures/bin.ts', import.meta.url))

/** Runs `__complete` and returns its lines. */
async function complete(...words: string[]): Promise<string[]> {
  const result = await invoke(cli, ['__complete', ...words])
  assert.equal(result.exitCode, 0)
  assert.equal(result.stderr, '')
  return result.stdout.split('\n').filter(Boolean)
}

/** Returns the candidate values without descriptions. */
async function values(...words: string[]): Promise<string[]> {
  return (await complete(...words)).map((line) => line.split('\t')[0] ?? '')
}

/** Returns `true` when a shell is installed. */
function hasShell(shell: string): boolean {
  return spawnSync(shell, ['-c', 'exit 0']).status === 0
}

/** Writes the fixture CLI as an `acme` executable and its scripts to a temporary directory. */
async function installFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clipact-completion-'))
  const acme = join(dir, 'acme')
  await writeFile(acme, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
  await chmod(acme, 0o755)
  for (const shell of ['bash', 'zsh']) {
    const result = await invoke(cli, ['completion', shell])
    await writeFile(join(dir, `acme.${shell}`), result.stdout)
  }
  return dir
}

/** Runs a shell script with the fixture CLI first on `PATH`. */
function runShell(shell: string, args: string[], dir: string, script: string) {
  const result = spawnSync(shell, args, {
    input: script,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}` },
  })
  assert.equal(result.stderr, '')
  return result.stdout.trim().split('\n')
}

describe('__complete', () => {
  test('completes commands, aliases, and built-ins at the root', async () => {
    assert.deepEqual(await complete(''), [
      'artifacts\tPublish and manage artifacts',
      'operations\tLong-running operations',
      'broken\tReturn invalid output',
      'publish\tAlias for artifacts put',
      'schema\tJSON Schema for a command, or the command list',
      'completion\tPrint a bash, zsh, or fish completion script',
    ])
    assert.deepEqual(await values('art'), ['artifacts'])
    assert.deepEqual(await values('artifacts', ''), ['put', 'get', 'label'])
    assert.deepEqual(await values('--v'), ['--version'])
  })

  test('offers flags without positionals, secrets, or flags already given', async () => {
    assert.deepEqual(await values('artifacts', 'put', '--'), [
      '--entry',
      '--copies',
      '--network',
      '--tags',
      '--yes',
      '--dry-run',
      '--input',
      '--json',
      '--format',
      '--agent',
      '--no-agent',
      '--debug',
      '--help',
    ])
    const later = await values(
      'artifacts',
      'put',
      '--tags',
      'x',
      '--entry=e',
      '--'
    )
    assert.ok(later.includes('--tags'), 'arrays are repeatable')
    assert.ok(!later.includes('--entry'))
    assert.deepEqual(await values('publish', '--net'), ['--network'])
  })

  test('completes flag values, positionals, and file paths', async () => {
    assert.deepEqual(await values('artifacts', 'put', '--network', ''), [
      'mainnet',
      'calibration',
    ])
    assert.deepEqual(await values('artifacts', 'put', '--network=ma'), [
      '--network=mainnet',
    ])
    assert.deepEqual(await values('artifacts', 'put', '--format', ''), [
      'human',
      'json',
    ])
    assert.deepEqual(await complete('artifacts', 'put', ''), [':files'])
    assert.deepEqual(
      await complete('artifacts', 'put', '--copies', '3', '--input', ''),
      [':files']
    )
    assert.deepEqual(await values('broken', 'c'), ['code', 'crash'])
    assert.deepEqual(await values('artifacts', 'put', '--copies', ''), [])
  })

  test('offers flags once positionals are filled and nothing after --', async () => {
    const after = await values('artifacts', 'put', './a.txt', '')
    assert.equal(after[0], '--entry')
    assert.deepEqual(await values('artifacts', 'put', '--', 'a', ''), [])
    assert.deepEqual(await complete('artifacts', 'label', 'id', 'a', ''), [
      ':files',
    ])
  })

  test('completes built-in commands', async () => {
    assert.deepEqual(await values('completion', ''), ['bash', 'zsh', 'fish'])
    assert.deepEqual(await values('schema', 'artifacts', 'g'), ['get'])
    assert.deepEqual(await values('schema', '--format', 'json', 'art'), [
      'artifacts',
    ])
    assert.deepEqual(await values('schema', 'artifacts', 'get', ''), [])
    assert.deepEqual((await values('schema', '--')).slice(0, 3), [
      '--list',
      '--input',
      '--json',
    ])
  })

  test('prints nothing for unknown commands and ignores --help and --version', async () => {
    assert.deepEqual(await complete('nope', ''), [])
    assert.deepEqual(await complete('--version', 'artifacts', 'put', ''), [
      ':files',
    ])
    assert.deepEqual(await values('artifacts', '--help', 'g'), ['get'])
  })
})

describe('completion', () => {
  test('prints the script in every mode', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const result = await invoke(cli, ['completion', shell])
      assert.equal(result.exitCode, 0)
      assert.match(
        result.stdout,
        new RegExp(`^(#compdef acme\n)?# ${shell} completion for acme`)
      )
      assert.match(result.stdout, /acme __complete /)
    }
  })

  test('rejects a missing or unknown shell', async () => {
    for (const args of [
      ['completion'],
      ['completion', 'tcsh'],
      ['completion', 'bash', 'zsh'],
    ]) {
      const result = await invoke(cli, args)
      const json = assertContract(result)
      assert.equal((json.error as { code: string }).code, 'invalid_input')
    }
    const flag = assertContract(await invoke(cli, ['completion', '--list']))
    assert.equal(
      (flag.error as { message: string }).message,
      '--list: Unknown flag.'
    )
  })

  test('is described by schema but stays out of command lists', async () => {
    const own = assertContract(await invoke(cli, ['schema', 'completion']))
    assert.deepEqual(own.positionals, ['shell'])
    assert.equal(own.readOnly, true)
    const list = assertContract(await invoke(cli, ['schema', '--list']))
    assert.ok(
      !(list.commands as { command: string }[]).some(
        (entry) => entry.command === 'completion'
      )
    )
  })

  test('prints the script even with invalid framework variables', async () => {
    const result = await invoke(cli, ['completion', 'bash'], {
      env: { ACME_AGENT: 'maybe' },
    })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /^# bash completion for acme/)
  })

  test('shows installation help to humans', async () => {
    for (const args of [['completion'], ['completion', '--help']]) {
      const result = await invoke(cli, args, { tty: true })
      assert.equal(result.exitCode, 0)
      assert.match(result.stdout, /source <\(acme completion zsh\)/)
    }
    const help = await invoke(cli, ['--help'], { tty: true })
    assert.match(help.stdout, /completion \[shell\]/)
  })

  // macOS ships bash 3.2 as /bin/bash, without mapfile or compopt.
  for (const bash of ['bash', '/bin/bash']) {
    test(`${bash} completes through the script`, {
      skip: !hasShell(bash),
    }, async () => {
      const dir = await installFixture()
      await writeFile(join(dir, 'my report.txt'), '')
      const lines = runShell(
        bash,
        ['--norc', '--noprofile'],
        dir,
        `source "${dir}/acme.bash"
cd "${dir}"
t() {
  COMP_LINE="$1"; COMP_POINT=\${#1}; read -ra COMP_WORDS <<< "$2"
  [[ $1 == *' ' ]] && COMP_WORDS+=('')
  COMP_CWORD=$((\${#COMP_WORDS[@]} - 1))
  _acme_complete
  local IFS='|'
  echo "\${COMPREPLY[*]}"
}
t 'acme art' 'acme art'
t 'acme artifacts put --network ' 'acme artifacts put --network'
t 'acme artifacts put --network=ma' 'acme artifacts put --network = ma'
t 'acme artifacts put --network=' 'acme artifacts put --network ='
t 'acme artifacts put my' 'acme artifacts put my'
`
      )
      assert.deepEqual(lines, [
        'artifacts',
        'mainnet|calibration',
        'mainnet',
        '=mainnet|=calibration',
        // compopt fails outside a real completion, so this checks bash 3.2's quoting.
        'my\\ report.txt',
      ])
    })
  }

  test('zsh completes through the script', {
    skip: !hasShell('zsh'),
  }, async () => {
    const dir = await installFixture()
    const lines = runShell(
      'zsh',
      ['-f'],
      dir,
      `_files() { echo files }
_describe() { print -l -- "\${(@P)4}" }
compdef() { echo "compdef $*" }
source "${dir}/acme.zsh"
words=(acme artifacts p); CURRENT=3; _acme
words=(acme artifacts put --network ''); CURRENT=5; _acme
words=(acme artifacts put ''); CURRENT=4; _acme
`
    )
    assert.deepEqual(lines, [
      'compdef _acme acme',
      'put:Publish a file and return a link',
      'mainnet',
      'calibration',
      'files',
    ])
  })
})
