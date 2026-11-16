import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AREAS, REST_AREA_NAME, planRuns } from '../../scripts/lint-areas.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('every area is a directory at the repo root', () => {
  for (const area of AREAS) {
    assert.ok(existsSync(`${ROOT}${area}`), `${area}/ does not exist`)
  }
})

test('each area is linted alone and the last run covers everything outside them', () => {
  const runs = planRuns()

  assert.deepEqual(
    runs.map(({ name }) => name),
    [...AREAS, REST_AREA_NAME],
  )
  assert.deepEqual(runs.at(-1).args.slice(0, 1), ['.'])
})

test('the last run ignores exactly the areas the other runs lint, so nothing is skipped or linted twice', () => {
  const runs = planRuns()
  const areaTargets = runs.slice(0, -1).map(({ args }) => args[0])
  const ignored = runs
    .at(-1)
    .args.flatMap((arg, index, all) => (all[index - 1] === '--ignore-pattern' ? [arg] : []))

  assert.deepEqual(ignored, areaTargets.map((target) => `${target}/`))
})

test('forwarded arguments reach every run', () => {
  for (const { args } of planRuns(['--fix', '--max-warnings', '0'])) {
    assert.deepEqual(args.slice(-3), ['--fix', '--max-warnings', '0'])
  }
})
