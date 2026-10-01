/**
 * Bundles the CLI with esbuild: one ESM entry with the framework, zod, and
 * all definitions, plus one lazily loaded chunk per handler.
 */
import { rm } from 'node:fs/promises'
import { build } from 'esbuild'

// esbuild never deletes old hashed chunks, so start from an empty outdir.
await rm('dist', { recursive: true, force: true })

const result = await build({
  entryPoints: ['src/main.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
})

const outputs = Object.entries(result.metafile.outputs)
  .filter(([file]) => file.endsWith('.js'))
  .map(
    ([file, output]) =>
      `${(output.bytes / 1024).toFixed(1).padStart(7)} KB  ${file}`
  )
process.stdout.write(`${outputs.join('\n')}\n`)
