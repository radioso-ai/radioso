/**
 * Release note construction.
 *
 * main is squash-merged with Conventional Commit subjects that carry their PR number, so a
 * release's notes are derivable from `git log` rather than hand-written. This module is the
 * pure half of that: commit subjects in, a version bump and a rendered changelog entry out,
 * with no git or filesystem access so the rules can be tested directly.
 *
 * Nothing is dropped. Subjects written before the convention settled, or by hand, land in an
 * "Other" section rather than disappearing from the release they actually shipped in.
 */

const CONVENTIONAL_SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<description>.+)$/
const TRAILING_PR = /\s*\(#(\d+)\)\s*$/
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m

/** Conventional type -> changelog section. A type absent here still renders, under "Other",
 *  because an unrecognised subject is a reason to read the release notes, not to hide it. */
const SECTION_BY_TYPE = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Performance',
  revert: 'Reverted',
  docs: 'Documentation',
  refactor: 'Internal',
  chore: 'Internal',
  build: 'Internal',
  ci: 'Internal',
  style: 'Internal',
  test: 'Internal',
}

/** Breaking changes lead, then what an operator upgrading actually cares about, then noise. */
const SECTION_ORDER = [
  'Breaking changes',
  'Added',
  'Fixed',
  'Performance',
  'Reverted',
  'Documentation',
  'Internal',
  'Other',
]

const OTHER_SECTION = 'Other'
const BREAKING_SECTION = 'Breaking changes'

export const parseCommit = ({ sha = '', subject = '', body = '' }) => {
  const match = CONVENTIONAL_SUBJECT.exec(subject.trim())
  const rawDescription = match ? match.groups.description : subject.trim()
  const prMatch = TRAILING_PR.exec(rawDescription)

  return {
    sha,
    type: match ? match.groups.type : null,
    scope: match?.groups.scope || null,
    // `!` marks the break on the subject; the footer is the long form. Either counts.
    breaking: Boolean(match?.groups.breaking) || BREAKING_FOOTER.test(body),
    description: rawDescription.replace(TRAILING_PR, '').trim(),
    pr: prMatch ? Number(prMatch[1]) : null,
  }
}

export const classifyBump = (commits) => {
  if (commits.some((commit) => commit.breaking)) return 'major'
  if (commits.some((commit) => commit.type === 'feat')) return 'minor'
  return 'patch'
}

export const nextVersion = (current, bump) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) throw new Error(`Cannot bump a version that is not plain semver: ${current}`)

  const [major, minor, patch] = match.slice(1).map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unknown bump: ${bump}`)
}

/** A breaking commit appears only under "Breaking changes". Listing it twice would let a
 *  reader skim past the section that exists to stop them. */
const sectionFor = (commit) => {
  if (commit.breaking) return BREAKING_SECTION
  if (commit.type === null) return OTHER_SECTION
  return SECTION_BY_TYPE[commit.type] ?? OTHER_SECTION
}

export const groupCommits = (commits) => {
  const sections = new Map()

  for (const commit of commits) {
    const section = sectionFor(commit)
    if (!sections.has(section)) sections.set(section, [])
    sections.get(section).push(commit)
  }

  return SECTION_ORDER.filter((section) => sections.has(section)).map((section) => ({
    title: section,
    commits: sections.get(section),
  }))
}

const renderCommit = (commit, repo) => {
  const scope = commit.scope ? `**${commit.scope}:** ` : ''
  const reference = commit.pr
    ? `[#${commit.pr}](https://github.com/${repo}/pull/${commit.pr})`
    : `[\`${commit.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit.sha})`

  return `- ${scope}${commit.description} (${reference})`
}

const renderMigrations = (migrations) => {
  if (migrations.length === 0) return []

  return [
    '### Database migrations',
    '',
    `This release adds ${migrations.length} migration${migrations.length === 1 ? '' : 's'}. ` +
      'They run at service startup, so deploy one stack at a time; overlapping deploys contend ' +
      'on the same DDL lock and stall until one gives up.',
    '',
    ...migrations.map((migration) => `- \`${migration}\``),
    '',
  ]
}

export const renderEntry = ({ version, date, commits, migrations = [], repo, previousTag = null }) => {
  const lines = [`## [${version}] - ${date}`, '']

  for (const section of groupCommits(commits)) {
    lines.push(`### ${section.title}`, '')
    lines.push(...section.commits.map((commit) => renderCommit(commit, repo)))
    lines.push('')
  }

  lines.push(...renderMigrations(migrations))

  const compare = previousTag
    ? `https://github.com/${repo}/compare/${previousTag}...v${version}`
    : `https://github.com/${repo}/releases/tag/v${version}`
  lines.push(`[${version}]: ${compare}`)

  return `${lines.join('\n')}\n`
}

export const CHANGELOG_HEADER = `# Changelog

Every release cut from \`main\`, newest first. Entries are generated from Conventional Commit
subjects by \`scripts/release/cut-release.mjs\`, so a subject that reaches main is the one an
operator reads here. The TypeScript SDK versions independently under its own
\`typescript-sdk-v*\` tags and is not listed below.
`

/** Splices a new entry above the newest existing one, so the file stays newest-first without
 *  the generator having to understand anything already in it. */
export const updateChangelog = (existing, entry, version) => {
  const body = existing.trim().length === 0 ? CHANGELOG_HEADER : existing

  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(body)) {
    throw new Error(`CHANGELOG.md already has an entry for ${version}; a release cannot be re-cut.`)
  }

  const firstEntry = body.search(/^## \[/m)
  if (firstEntry === -1) return `${body.trimEnd()}\n\n${entry}`

  return `${body.slice(0, firstEntry)}${entry}\n${body.slice(firstEntry)}`
}

/** The changelog keeps its compare URL as a reference-style definition, which renders as
 *  nothing on a GitHub release page. Swap it for a line a reader can actually click. */
export const toReleaseBody = (entry, version) =>
  entry.replace(
    new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: (.+)$`, 'm'),
    '**Full changelog**: $1',
  ).trim()

/** The types the changelog knows how to file. Exported so the PR-title gate and the generator
 *  cannot drift apart: anything the gate admits, the changelog already has a section for. */
export const KNOWN_TYPES = Object.keys(SECTION_BY_TYPE)

/** The commit a release cut leaves behind. It records a release rather than making a change,
 *  so the next release's notes skip it instead of reporting it as internal work. */
export const isReleaseCommit = (commit) => commit.type === 'chore' && commit.scope === 'release'
