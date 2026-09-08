import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  'scripts/release/check-pr-title.mjs',
)

const check = (title) => {
  try {
    execFileSync('node', [SCRIPT], {
      env: { ...process.env, PR_TITLE: title },
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { accepted: true, output: '' }
  } catch (error) {
    return { accepted: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('accepts the subject shapes the changelog files under a real section', () => {
  for (const title of [
    'feat: add an agent bundle importer',
    'feat(retrieval): rank lexical hits on their query-relative score',
    'fix(auth)!: reject tokens minted before the rotation',
    'chore: raise the pnpm version across the workspace',
  ]) {
    assert.equal(check(title).accepted, true, `expected to accept: ${title}`)
  }
})

test('rejects a title that would land in the "Other" bucket', () => {
  const result = check('Stop asking the planner for dead fields')

  assert.equal(result.accepted, false)
  assert.match(result.output, /not a Conventional Commit subject/)
})

test('rejects an unknown type rather than filing it as Other', () => {
  assert.match(check('wibble: do a thing properly').output, /not a known commit type/)
})

test('rejects the cosmetic slips that make a changelog read badly', () => {
  assert.match(check('feat: Add an agent bundle importer').output, /lower case/)
  assert.match(check('feat: add an agent bundle importer.').output, /trailing period/)
  assert.match(check('feat: add it').output, /too short/)
})

test('rejects a hand-written PR number that GitHub appends anyway', () => {
  assert.match(check('feat: add an agent bundle importer (#1234)').output, /GitHub appends/)
})

test('rejects an empty title instead of passing it through', () => {
  assert.match(check('').output, /needs a pull request title/)
})
