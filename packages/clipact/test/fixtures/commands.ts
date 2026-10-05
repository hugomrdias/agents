import * as z from 'zod'
import { defineCommand, defineGroup } from '../../src/index.ts'

/** Publishes a file; confirms on mainnet and supports dry runs. */
export const put = defineCommand({
  name: 'put',
  description: 'Publish a file and return a link',
  examples: ['acme artifacts put ./report.pdf'],
  input: z.strictObject({
    path: z.string().describe('File to publish'),
    entry: z.string().optional().describe('Entry file for folders'),
    copies: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(2)
      .describe('Committed copies'),
    network: z
      .enum(['mainnet', 'calibration'])
      .default('calibration')
      .describe('Target network'),
    tags: z.array(z.string()).optional().describe('Labels'),
    privateKey: z.string().describe('Signing key'),
  }),
  positionals: ['path'],
  env: { network: 'ACME_NETWORK', privateKey: 'ACME_PRIVATE_KEY' },
  secrets: ['privateKey'],
  output: z.object({
    ref: z.string(),
    url: z.url(),
    tags: z.array(z.string()).optional(),
  }),
  errors: ['insufficient_funds'],
  confirm: (input) =>
    input.network === 'mainnet'
      ? `Spends mainnet funds for ${input.copies} copies.`
      : undefined,
  dryRun: true,
  handler: () => import('./put.run.ts'),
})

/** Reads an artifact. */
export const get = defineCommand({
  name: 'get',
  description: 'Show an artifact',
  input: z.strictObject({ id: z.string().describe('Artifact ID') }),
  positionals: ['id'],
  output: z.object({ id: z.string(), size: z.number() }),
  errors: ['not_found'],
  readOnly: true,
  handler: () => import('./get.run.ts'),
})

/** Lists artifacts as a bare array. */
export const ls = defineCommand({
  name: 'ls',
  description: 'List artifacts',
  output: z.array(z.object({ id: z.string() })),
  readOnly: true,
  handler: () => import('./ls.run.ts'),
})

/** Labels an artifact; takes a variadic positional. */
export const label = defineCommand({
  name: 'label',
  description: 'Add labels to an artifact',
  input: z.strictObject({
    id: z.string(),
    labels: z.array(z.string()).min(1),
    force: z.boolean().default(false),
  }),
  positionals: ['id', 'labels'],
  idempotent: true,
  handler: () => import('./label.run.ts'),
})

/** Waits on a long-running operation until interrupted. */
export const wait = defineCommand({
  name: 'wait',
  description: 'Wait for an operation',
  input: z.strictObject({ ms: z.number().int().default(10_000) }),
  output: z.object({ done: z.boolean() }),
  handler: () => import('./wait.run.ts'),
})

/** Returns output that breaks its contract, for strict-mode tests. */
export const broken = defineCommand({
  name: 'broken',
  description: 'Return invalid output',
  input: z.strictObject({
    kind: z.enum(['output', 'code', 'retryable', 'crash', 'details', 'bigint']),
  }),
  positionals: ['kind'],
  output: z.object({ ref: z.string() }),
  handler: () => import('./broken.run.ts'),
})

export const commands = [
  defineGroup({
    name: 'artifacts',
    description: 'Publish and manage artifacts',
    commands: [put, get, ls, label],
  }),
  defineGroup({
    name: 'operations',
    description: 'Long-running operations',
    commands: [wait],
  }),
  broken,
]
