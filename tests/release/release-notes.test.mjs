import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHANGELOG_HEADER,
  assertPlainSemver,
  classifyBump,
  groupCommits,
  isReleaseCommit,
  nextVersion,
  parseCommit,
  renderEntry,
  toReleaseBody,
  updateChangelog,
} from '../../scripts/release/releaseNotes.mjs'

const REPO = 'radioso-ai/radioso'

test('parses a scoped conventional subject and strips its squash-merge PR reference', () => {
  const commit = parseCommit({
    sha: 'aaaaaaaaaaaa',
    subject: 'feat(audience-pulse): show topic change over time (#1191)',
  })

  assert.equal(commit.type, 'feat')
  assert.equal(commit.scope, 'audience-pulse')
  assert.equal(commit.description, 'show topic change over time')
  assert.equal(commit.pr, 1191)
  assert.equal(commit.breaking, false)
})

test('keeps a subject that predates the convention instead of dropping it', () => {
  const commit = parseCommit({
    sha: 'f49e25d24aaa',
    subject: 'Stop asking the planner for dead fields (#1189)',
  })

  assert.equal(commit.type, null)
  assert.equal(commit.description, 'Stop asking the planner for dead fields')
  assert.equal(commit.pr, 1189)
  assert.deepEqual(
    groupCommits([commit]).map((section) => section.title),
    ['Other'],
  )
})

test('reads a breaking change from the subject marker or the body footer', () => {
  assert.equal(parseCommit({ subject: 'feat!: drop the legacy field' }).breaking, true)
  assert.equal(parseCommit({ subject: 'feat(api)!: drop the legacy field' }).breaking, true)
  assert.equal(
    parseCommit({ subject: 'fix: tighten validation', body: 'BREAKING CHANGE: rejects empty ids' })
      .breaking,
    true,
  )
  assert.equal(parseCommit({ subject: 'fix: tighten validation', body: 'Nothing special' }).breaking, false)
})

test('bumps major on a break, minor on a feature, patch otherwise', () => {
  const commits = (...subjects) => subjects.map((subject) => parseCommit({ subject }))

  assert.equal(classifyBump(commits('fix: a', 'feat: b', 'feat!: c')), 'major')
  assert.equal(classifyBump(commits('fix: a', 'feat: b')), 'minor')
  assert.equal(classifyBump(commits('fix: a', 'chore: b')), 'patch')
  assert.equal(classifyBump([]), 'patch')
})

test('computes the next semver and refuses a version it cannot bump', () => {
  assert.equal(nextVersion('1.4.2', 'major'), '2.0.0')
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0')
  assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3')
  assert.throws(() => nextVersion('1.4.2-rc.1', 'patch'), /not plain semver/)
  assert.throws(() => nextVersion('1.4.2', 'sideways'), /Unknown bump/)
})

test('rejects explicit release versions that would not deploy as release tags', () => {
  assert.equal(assertPlainSemver('1.4.0'), '1.4.0')
  assert.throws(() => assertPlainSemver('v1.4.0'), /plain semver/)
  assert.throws(() => assertPlainSemver('1.4'), /plain semver/)
  assert.throws(() => assertPlainSemver('not-a-version'), /plain semver/)
})

test('orders sections so breaking changes lead and internal work trails', () => {
  const commits = [
    'chore: tidy imports',
    'feat: add a thing',
    'feat!: remove a thing',
    'fix: repair a thing',
    'docs: explain a thing',
  ].map((subject) => parseCommit({ subject }))

  assert.deepEqual(
    groupCommits(commits).map((section) => section.title),
    ['Breaking changes', 'Added', 'Fixed', 'Documentation', 'Internal'],
  )
})

test('lists a breaking feature once, under breaking changes only', () => {
  const sections = groupCommits([parseCommit({ subject: 'feat!: remove a thing' })])

  assert.equal(sections.length, 1)
  assert.equal(sections[0].title, 'Breaking changes')
})

test('renders PR links, commit links for unreferenced commits, and a compare link', () => {
  const entry = renderEntry({
    version: '1.1.0',
    date: '2026-09-06',
    repo: REPO,
    previousTag: 'v1.0.0',
    commits: [
      parseCommit({ subject: 'feat(retrieval): rank lexical hits (#1187)' }),
      parseCommit({ sha: 'abc1234def56', subject: 'fix: handle empty uploads' }),
    ],
  })

  assert.match(entry, /^## \[1\.1\.0\] - 2026-09-06$/m)
  assert.match(entry, /- \*\*retrieval:\*\* rank lexical hits \(\[#1187\]\(https:\/\/github\.com\/radioso-ai\/radioso\/pull\/1187\)\)/)
  assert.match(entry, /- handle empty uploads \(\[`abc1234`\]\(https:\/\/github\.com\/radioso-ai\/radioso\/commit\/abc1234def56\)\)/)
  assert.match(entry, /\[1\.1\.0\]: https:\/\/github\.com\/radioso-ai\/radioso\/compare\/v1\.0\.0\.\.\.v1\.1\.0/)
})

test('points the first release at its own tag rather than an absent comparison', () => {
  const entry = renderEntry({
    version: '1.0.0',
    date: '2026-09-06',
    repo: REPO,
    previousTag: null,
    commits: [parseCommit({ subject: 'feat: ship it' })],
  })

  assert.match(entry, /\[1\.0\.0\]: https:\/\/github\.com\/radioso-ai\/radioso\/releases\/tag\/v1\.0\.0/)
})

test('warns about serialised deploys only when the release carries migrations', () => {
  const withMigrations = renderEntry({
    version: '1.1.0',
    date: '2026-09-06',
    repo: REPO,
    commits: [parseCommit({ subject: 'feat: ship it' })],
    migrations: ['170_topic_transition_title.sql'],
  })

  assert.match(withMigrations, /### Database migrations/)
  assert.match(withMigrations, /adds 1 migration\./)
  assert.match(withMigrations, /one stack at a time/)
  assert.match(withMigrations, /`170_topic_transition_title\.sql`/)

  const withoutMigrations = renderEntry({
    version: '1.1.0',
    date: '2026-09-06',
    repo: REPO,
    commits: [parseCommit({ subject: 'feat: ship it' })],
  })

  assert.doesNotMatch(withoutMigrations, /### Database migrations/)
})

test('pluralises the migration count', () => {
  const entry = renderEntry({
    version: '1.1.0',
    date: '2026-09-06',
    repo: REPO,
    commits: [],
    migrations: ['169_a.sql', '170_b.sql'],
  })

  assert.match(entry, /adds 2 migrations\./)
})

test('splices a new entry above the newest existing one', () => {
  const existing = `${CHANGELOG_HEADER}\n## [1.0.0] - 2026-09-01\n\n### Added\n\n- first\n\n[1.0.0]: x\n`
  const entry = renderEntry({
    version: '1.1.0',
    date: '2026-09-06',
    repo: REPO,
    previousTag: 'v1.0.0',
    commits: [parseCommit({ subject: 'feat: second' })],
  })

  const updated = updateChangelog(existing, entry, '1.1.0')

  assert.ok(updated.startsWith(CHANGELOG_HEADER))
  assert.ok(updated.indexOf('## [1.1.0]') < updated.indexOf('## [1.0.0]'))
  assert.match(updated, /- first/)
})

test('seeds a header when the changelog is empty', () => {
  const entry = renderEntry({ version: '1.0.0', date: '2026-09-06', repo: REPO, commits: [] })

  assert.ok(updateChangelog('', entry, '1.0.0').startsWith('# Changelog'))
})

test('refuses to re-cut a version already in the changelog', () => {
  const existing = `${CHANGELOG_HEADER}\n## [1.1.0] - 2026-09-06\n\n[1.1.0]: x\n`
  const entry = renderEntry({ version: '1.1.0', date: '2026-09-07', repo: REPO, commits: [] })

  assert.throws(() => updateChangelog(existing, entry, '1.1.0'), /cannot be re-cut/)
})

test('turns the reference-style compare link into a clickable release-page line', () => {
  const entry = renderEntry({
    version: '1.1.0',
    date: '2026-09-06',
    repo: REPO,
    previousTag: 'v1.0.0',
    commits: [parseCommit({ subject: 'feat: ship it' })],
  })

  const body = toReleaseBody(entry, '1.1.0')

  assert.doesNotMatch(body, /^\[1\.1\.0\]:/m)
  assert.match(body, /\*\*Full changelog\*\*: https:\/\/github\.com\/radioso-ai\/radioso\/compare\/v1\.0\.0\.\.\.v1\.1\.0/)
})

test('recognises the commit a release cut leaves behind, so the next release skips it', () => {
  assert.equal(isReleaseCommit(parseCommit({ subject: 'chore(release): v1.2.0' })), true)
  assert.equal(isReleaseCommit(parseCommit({ subject: 'chore: tidy imports' })), false)
  assert.equal(isReleaseCommit(parseCommit({ subject: 'feat(release): add a release page' })), false)
})
