#!/usr/bin/env node
/**
 * Cuts a release from main.
 *
 * A release names a commit, not a deployment. Radioso runs on more than one production stack,
 * so minting a version at deploy time would either give one commit two numbers or hide that
 * one stack is several releases behind another. The tag therefore exists before any deploy,
 * and a deploy is told which release to ship.
 *
 * Reads the Conventional Commit subjects since the previous `v*` tag, derives the next
 * version, writes the CHANGELOG.md entry, and bumps the workspace version. Tagging, pushing
 * and the GitHub Release are the workflow's job, so a dry run here is genuinely read-only.
 *
 *   node scripts/release/cut-release.mjs --bump=auto
 *   node scripts/release/cut-release.mjs --version=1.0.0 --since=<sha>
 *   node scripts/release/cut-release.mjs --dry-run
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  classifyBump,
  isReleaseCommit,
  nextVersion,
  parseCommit,
  renderEntry,
  toReleaseBody,
  updateChangelog,
} from './releaseNotes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md')
const PACKAGE_PATH = join(ROOT, 'package.json')
const MIGRATIONS_DIR = 'backend/src/db/migrations'

/** ASCII record/field separators: a commit body can contain any newline or punctuation a
 *  contributor likes, but not these. */
const RECORD = '\x1e'
const FIELD = '\x1f'

const args = process.argv.slice(2)
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const isDryRun = args.includes('--dry-run')

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim()

const fail = (message) => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** `v*` deliberately excludes the SDK's `typescript-sdk-v*` tags: the SDK versions on its own
 *  cadence and its releases are not this product's releases. */
const previousReleaseTag = () => {
  const tags = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean)
  return tags[0] ?? null
}

const repoSlug = () => {
  const override = flag('repo')
  if (override) return override

  const remote = git('remote', 'get-url', 'origin')
  const match = /github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)
  if (!match) fail(`Cannot read an owner/name slug from the origin remote: ${remote}`)
  return match.groups.slug
}

const commitsSince = (since) =>
  git('log', `${since}..HEAD`, '--no-merges', `--format=%H%x1f%s%x1f%b%x1e`)
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body] = record.split(FIELD)
      return parseCommit({ sha, subject, body })
    })
    .filter((commit) => !isReleaseCommit(commit))

/** Only additions count. A migration edited after it shipped is a different problem, and one
 *  the release notes should not present as new work to run. */
const migrationsSince = (since) =>
  git('diff', '--name-only', '--diff-filter=A', `${since}..HEAD`, '--', MIGRATIONS_DIR)
    .split('\n')
    .filter(Boolean)
    .map((path) => path.slice(`${MIGRATIONS_DIR}/`.length))
    .sort()

const readWorkspaceVersion = () => {
  const match = /^\s*"version":\s*"(?<version>[^"]*)"/m.exec(readFileSync(PACKAGE_PATH, 'utf8'))
  if (!match) fail('The root package.json has no "version" field to bump.')
  return match.groups.version
}

const writeWorkspaceVersion = (version) => {
  const contents = readFileSync(PACKAGE_PATH, 'utf8')
  writeFileSync(PACKAGE_PATH, contents.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`))
}

const main = () => {
  const previousTag = previousReleaseTag()
  const since = flag('since') ?? previousTag

  if (!since) {
    fail(
      'No `v*` tag exists yet, so there is no point to generate notes from.\n' +
        'Pass the first release explicitly, for example:\n' +
        '  --version=1.0.0 --since=<commit the release starts after>',
    )
  }

  const commits = commitsSince(since)
  if (commits.length === 0) fail(`No commits between ${since} and HEAD. There is nothing to release.`)

  const bump = flag('bump') ?? 'auto'
  const version =
    flag('version') ??
    nextVersion(readWorkspaceVersion(), bump === 'auto' ? classifyBump(commits) : bump)

  const entry = renderEntry({
    version,
    date: new Date().toISOString().slice(0, 10),
    commits,
    migrations: migrationsSince(since),
    repo: repoSlug(),
    previousTag,
  })

  const existing = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, 'utf8') : ''
  const changelog = updateChangelog(existing, entry, version)

  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) writeFileSync(githubOutput, `version=${version}\ntag=v${version}\n`, { flag: 'a' })

  const notesOut = flag('notes-out')
  if (notesOut) writeFileSync(notesOut, `${toReleaseBody(entry, version)}\n`)

  console.log(entry)
  console.log(`${commits.length} commits since ${since}.`)

  if (isDryRun) {
    console.log('Dry run: CHANGELOG.md and package.json are unchanged.')
    return
  }

  writeFileSync(CHANGELOG_PATH, changelog)
  writeWorkspaceVersion(version)

  console.log(`Wrote CHANGELOG.md and set the workspace version to ${version}.`)
}

main()
