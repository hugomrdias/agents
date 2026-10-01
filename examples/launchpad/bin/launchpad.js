#!/usr/bin/env node
// Entry shim: enable the compile cache first, then load the bundle
// dynamically so it is compiled with the cache on.
import module from 'node:module'

module.enableCompileCache?.()
await import('../dist/main.js')
