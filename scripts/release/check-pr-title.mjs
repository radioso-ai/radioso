#!/usr/bin/env node
/**
 * Gates a pull request title against the Conventional Commit grammar.
 *
 * main is squash-merged, and GitHub seeds the squash subject from the PR title, so the title
 * is the changelog line. This gate runs the same parser the generator does: a title that
 * passes here is a title `cut-release.mjs` can file under a real section rather than "Other".
 */
import { KNOWN_TYPES, parseCommit } from './releaseNotes.mjs'

const title = (process.env.PR_TITLE ?? process.argv[2] ?? '').trim()

const reject = (reason) => {
  console.error(`::error::${reason}`)
  console.error(
    [
      '',
      `Title: ${title || '(empty)'}`,
      '',
      'Use a Conventional Commit subject, because this becomes the squashed commit and the',
      'changelog line for the release that ships it:',
      '',
      '  <type>[(scope)][!]: <description>',
      '',
      `  type   one of: ${KNOWN_TYPES.join(', ')}`,
      '  !      the change breaks an API, SDK, connector or worker contract',
      '',
      'For example:',
      '  feat(retrieval): rank lexical hits on their query-relative score',
      '  fix: keep document searches out of the inbox',
      '  feat(api)!: require an agent id on retrieval requests',
    ].join('\n'),
  )
  process.exit(1)
}

if (!title) reject('This check needs a pull request title to read.')

const commit = parseCommit({ subject: title })

if (commit.type === null) reject('The pull request title is not a Conventional Commit subject.')
if (!KNOWN_TYPES.includes(commit.type)) reject(`"${commit.type}" is not a known commit type.`)
if (commit.description.length < 10) reject('The description is too short to read as a changelog line.')
if (commit.description.endsWith('.')) reject('Drop the trailing period; changelog lines do not carry one.')
if (/^[A-Z][a-z]/.test(commit.description)) reject('Start the description in lower case.')
if (commit.pr !== null) reject('Drop the "(#123)" suffix; GitHub appends the PR number when it squashes.')

console.log(`Pull request title is a valid ${commit.breaking ? 'breaking ' : ''}"${commit.type}" subject.`)
