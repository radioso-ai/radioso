import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LINE_LIMIT,
  buildScopeRoots,
  countLines,
  evaluateFileSizes,
  isGeneratedByHeader,
  planBaselineUpdate,
} from '../../scripts/file-size-ratchet.mjs'

test('does not run the CLI on import: the pure functions are just functions', () => {
  assert.equal(typeof evaluateFileSizes, 'function')
  assert.equal(typeof planBaselineUpdate, 'function')
  assert.equal(LINE_LIMIT, 1000)
})

test('a file at exactly the limit is fine; one line over fails', () => {
  const atLimit = evaluateFileSizes({ counts: { 'backend/src/a.ts': 1000 }, baseline: {} })
  assert.deepEqual(atLimit, [])

  const overLimit = evaluateFileSizes({ counts: { 'backend/src/a.ts': 1001 }, baseline: {} })
  assert.equal(overLimit.length, 1)
  assert.equal(overLimit[0].type, 'new-over-limit')
  assert.equal(overLimit[0].file, 'backend/src/a.ts')
  assert.equal(overLimit[0].lines, 1001)
})

test('rule 2: a file over the limit with no baseline entry fails', () => {
  const violations = evaluateFileSizes({
    counts: { 'backend/src/new-big-file.ts': 1200 },
    baseline: {},
  })

  assert.deepEqual(violations, [
    { type: 'new-over-limit', file: 'backend/src/new-big-file.ts', lines: 1200, limit: 1000 },
  ])
})

test('rule 2: a baselined file matching its recorded count passes', () => {
  const violations = evaluateFileSizes({
    counts: { 'backend/src/known-big-file.ts': 1500 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
  })

  assert.deepEqual(violations, [])
})

test('rule 3: a baselined file that grows past its recorded count fails', () => {
  const violations = evaluateFileSizes({
    counts: { 'backend/src/known-big-file.ts': 1600 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
  })

  assert.deepEqual(violations, [
    {
      type: 'grew',
      file: 'backend/src/known-big-file.ts',
      lines: 1600,
      limit: 1000,
      baselineLines: 1500,
    },
  ])
})

test('rule 4: a baselined file that shrank, but is still over the limit, fails until re-recorded', () => {
  const violations = evaluateFileSizes({
    counts: { 'backend/src/known-big-file.ts': 1400 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
  })

  assert.deepEqual(violations, [
    {
      type: 'stale',
      file: 'backend/src/known-big-file.ts',
      lines: 1400,
      limit: 1000,
      baselineLines: 1500,
      reason: 'shrank',
    },
  ])
})

test('rule 4: a baselined file that dropped under the limit fails until re-recorded', () => {
  const violations = evaluateFileSizes({
    counts: { 'backend/src/known-big-file.ts': 900 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
  })

  assert.deepEqual(violations, [
    {
      type: 'stale',
      file: 'backend/src/known-big-file.ts',
      lines: 900,
      limit: 1000,
      baselineLines: 1500,
      reason: 'dropped-below-limit',
    },
  ])
})

test('rule 4: a baselined file that no longer exists fails until re-recorded', () => {
  const violations = evaluateFileSizes({
    counts: {},
    baseline: { 'backend/src/deleted-file.ts': 1500 },
  })

  assert.deepEqual(violations, [
    {
      type: 'stale',
      file: 'backend/src/deleted-file.ts',
      lines: null,
      limit: 1000,
      baselineLines: 1500,
      reason: 'removed',
    },
  ])
})

test('an unrelated baselined file elsewhere does not mask a real violation', () => {
  const violations = evaluateFileSizes({
    counts: {
      'backend/src/known-big-file.ts': 1500,
      'backend/src/new-big-file.ts': 1100,
    },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
  })

  assert.deepEqual(violations, [
    { type: 'new-over-limit', file: 'backend/src/new-big-file.ts', lines: 1100, limit: 1000 },
  ])
})

test('rule 5: --update refuses to add a new baseline entry without --allow-growth', () => {
  const plan = planBaselineUpdate({
    counts: { 'backend/src/new-big-file.ts': 1200 },
    baseline: {},
    allowGrowth: false,
  })

  assert.equal(plan.blocked, true)
  assert.deepEqual(plan.added, [{ file: 'backend/src/new-big-file.ts', lines: 1200 }])
  assert.deepEqual(plan.raised, [])
})

test('rule 5: --update refuses to raise an existing entry without --allow-growth', () => {
  const plan = planBaselineUpdate({
    counts: { 'backend/src/known-big-file.ts': 1600 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
    allowGrowth: false,
  })

  assert.equal(plan.blocked, true)
  assert.deepEqual(plan.raised, [{ file: 'backend/src/known-big-file.ts', from: 1500, to: 1600 }])
})

test('rule 5: --allow-growth permits adding and raising, and records the new counts', () => {
  const plan = planBaselineUpdate({
    counts: {
      'backend/src/new-big-file.ts': 1200,
      'backend/src/known-big-file.ts': 1600,
    },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
    allowGrowth: true,
  })

  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.baseline, {
    'backend/src/new-big-file.ts': 1200,
    'backend/src/known-big-file.ts': 1600,
  })
})

test('rule 5: lowering or removing an entry is always allowed, with or without --allow-growth', () => {
  const counts = { 'backend/src/known-big-file.ts': 1400 }
  const baseline = {
    'backend/src/known-big-file.ts': 1500,
    'backend/src/deleted-file.ts': 1100,
  }

  for (const allowGrowth of [false, true]) {
    const plan = planBaselineUpdate({ counts, baseline, allowGrowth })
    assert.equal(plan.blocked, false)
    assert.deepEqual(plan.lowered, [{ file: 'backend/src/known-big-file.ts', from: 1500, to: 1400 }])
    assert.deepEqual(plan.removed, [{ file: 'backend/src/deleted-file.ts', from: 1100 }])
    assert.deepEqual(plan.baseline, { 'backend/src/known-big-file.ts': 1400 })
  }
})

test('rule 5: a file that drops under the limit is removed from the baseline, not kept at 0', () => {
  const plan = planBaselineUpdate({
    counts: { 'backend/src/known-big-file.ts': 800 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
    allowGrowth: false,
  })

  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.removed, [{ file: 'backend/src/known-big-file.ts', from: 1500 }])
  assert.deepEqual(plan.baseline, {})
})

test('rule 5: an update that matches reality exactly changes nothing and is never blocked', () => {
  const plan = planBaselineUpdate({
    counts: { 'backend/src/known-big-file.ts': 1500 },
    baseline: { 'backend/src/known-big-file.ts': 1500 },
    allowGrowth: false,
  })

  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.added, [])
  assert.deepEqual(plan.raised, [])
  assert.deepEqual(plan.lowered, [])
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.baseline, { 'backend/src/known-big-file.ts': 1500 })
})

test('countLines matches `wc -l`: it counts newline characters, not visual lines', () => {
  assert.equal(countLines('a\nb\nc\n'), 3)
  // No trailing newline on the last line: `wc -l` does not count it either.
  assert.equal(countLines('a\nb\nc'), 2)
  assert.equal(countLines(''), 0)
})

test('isGeneratedByHeader matches a real codegen marker from this repo', () => {
  const header = '/**\n * This file was generated by kysely-codegen.\n * Please do not edit it manually.\n */\n'
  assert.equal(isGeneratedByHeader(header), true)
})

test('isGeneratedByHeader does not fire on ordinary prose that happens to use the word "generated"', () => {
  const content = '/**\n * The rolling per-conversation summary, regenerated off the critical path.\n */\nexport const x = 1\n'
  assert.equal(isGeneratedByHeader(content), false)
})

test('isGeneratedByHeader only looks at the head of the file, not a marker buried deep inside it', () => {
  const content = `${'// padding\n'.repeat(20)}// This file was generated by some tool. Do not edit.\n`
  assert.equal(isGeneratedByHeader(content), false)
})

test('scope roots fall back to the package root for packages that keep source outside src/', () => {
  const roots = buildScopeRoots()

  // packages/census keeps its source under src/, like most packages in the workspace.
  assert.ok(roots.includes('packages/census/src'))
  // packages/connector-api ships its contract as root-level .d.ts files with no src/ dir;
  // the scope root must be the package root itself, or this package is silently never scanned.
  assert.ok(roots.includes('packages/connector-api'))
  assert.ok(!roots.includes('packages/connector-api/src'))
})
