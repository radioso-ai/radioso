#!/usr/bin/env node
/**
 * Runs the repo's single ESLint config one area at a time, each in its own process.
 *
 * Type-aware rules keep a TypeScript program per tsconfig in memory for the whole run. One
 * `eslint .` over the monorepo therefore peaks at the sum of every area's programs, and that sum
 * grows with each backend file until the heap limit stops the job. Linting the areas one after
 * another frees each area's programs when its process exits, so the peak is the largest area's
 * rather than the sum, with the same rules and the same files.
 *
 * Coverage is complete by construction: the last run is `eslint .` with every named area ignored,
 * so a directory that has no area of its own is linted there, and adding an area to AREAS removes
 * it from that run without a second edit.
 *
 * Extra arguments (`--fix`, `--max-warnings 0`, ...) go to every run. Every area runs even when an
 * earlier one fails, so a single pass lists all the findings; the exit code is the first failing
 * area's.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Per-process heap. The largest area, backend, needs more than Node's default. */
export const HEAP_FLAG = '--max-old-space-size=8192'

/** Directories linted on their own. Everything outside them is linted by the final run. */
export const AREAS = ['backend', 'frontend', 'ee', 'packages']

export const REST_AREA_NAME = 'everything else'

export const planRuns = (forwardedArgs = []) => [
  ...AREAS.map((area) => ({ name: area, args: [area, ...forwardedArgs] })),
  {
    name: REST_AREA_NAME,
    args: ['.', ...AREAS.flatMap((area) => ['--ignore-pattern', `${area}/`]), ...forwardedArgs],
  },
]

const resolveEslintBin = () => {
  const require = createRequire(import.meta.url)
  const manifest = require('eslint/package.json')
  return join(dirname(require.resolve('eslint/package.json')), manifest.bin.eslint)
}

const withHeapFlag = (env) => ({
  ...env,
  // Appended last, so it wins over a smaller --max-old-space-size already in NODE_OPTIONS.
  NODE_OPTIONS: [env.NODE_OPTIONS, HEAP_FLAG].filter(Boolean).join(' '),
})

const runArea = (eslintBin, { name, args }) => {
  console.log(`\nlint-areas: ${name}`)
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [eslintBin, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: withHeapFlag(process.env),
  })
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const exitCode = typeof result.status === 'number' ? result.status : 1
  const how = result.signal ? `killed by ${result.signal}` : `exit ${exitCode}`
  console.log(`lint-areas: ${name} ${exitCode === 0 ? 'passed' : `FAILED (${how})`} in ${seconds}s`)
  return { name, exitCode }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], 'file:').href
  : false

if (isDirectRun) {
  const eslintBin = resolveEslintBin()
  const results = planRuns(process.argv.slice(2)).map((run) => runArea(eslintBin, run))
  const failures = results.filter(({ exitCode }) => exitCode !== 0)

  if (failures.length > 0) {
    console.error(`\nlint-areas: failed in ${failures.map(({ name }) => name).join(', ')}`)
    if (failures.some(({ exitCode }) => exitCode === 134)) {
      console.error('lint-areas: exit 134 is a Node heap out-of-memory abort, not a lint finding.')
    }
    process.exit(failures[0].exitCode)
  }
}
