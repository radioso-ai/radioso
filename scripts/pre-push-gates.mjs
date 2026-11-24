#!/usr/bin/env node
/**
 * Pre-push gates.
 *
 * Runs the two ratchets that fail pull requests most often, the file-size and dead-code
 * gates, before a push leaves the machine, so a red CI run does not have to say it first.
 * The git pre-push hook installed by `scripts/install-git-hooks.mjs` calls this with the
 * refs being pushed on stdin.
 *
 * The gates read the working tree, so they only run when the pushed commit is the one
 * checked out. A push the hook cannot check (deleted refs only, another commit, missing
 * dependencies) goes through with a note; CI still runs every gate.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_REF = 'origin/main'

/** Files whose change can move knip's findings: sources, manifests, configs, the baseline, the lockfile. */
const DEAD_CODE_INPUT = /\.(?:[cm]?[jt]sx?|json)$|(?:^|\/)pnpm-lock\.yaml$/

const GATES = {
  'file-size': { label: 'file-size ratchet', script: 'scripts/file-size-ratchet.mjs', args: [] },
  'dead-code': { label: 'dead-code ratchet (up to a minute)', script: 'scripts/knip-ratchet.mjs', args: [`--base=${BASE_REF}`] },
}

/** `<local ref> <local sha> <remote ref> <remote sha>` per line, as git hands it to pre-push. */
export const parsePushUpdates = (stdin) =>
  stdin
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4 && !/^0+$/.test(fields[1]))
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }))

/** knip loses every globbed workspace (`packages/*`) when the checkout's absolute path has a dot directory. */
const dotDirectoryIn = (rootPath) => rootPath.split(sep).find((segment) => segment.startsWith('.') && segment.length > 1)

export const planPushGates = ({ updates, headSha, changedFiles, rootPath, knipInstalled }) => {
  if (updates.length === 0) {
    return { gates: [], notes: [] }
  }
  if (!updates.some((update) => update.localSha === headSha)) {
    return {
      gates: [],
      notes: ['gates skipped: the pushed commit is not the one checked out, and the gates read the working tree. CI checks it.'],
    }
  }

  const gates = ['file-size']
  const notes = []
  const dotDirectory = dotDirectoryIn(rootPath)
  if (changedFiles === null) {
    notes.push(`dead-code gate skipped: no merge base with ${BASE_REF}. Fetch it to check locally; CI runs the gate.`)
  } else if (!changedFiles.some((file) => DEAD_CODE_INPUT.test(file))) {
    // Nothing knip reads changed, so its findings cannot have either.
  } else if (!knipInstalled) {
    notes.push('dead-code gate skipped: dependencies are not installed. Run `pnpm install` to check locally; CI runs the gate.')
  } else if (dotDirectory) {
    notes.push(`dead-code gate skipped: knip misreads the workspaces when the checkout path has a dot directory (${dotDirectory}). CI runs the gate.`)
  } else {
    gates.push('dead-code')
  }
  return { gates, notes }
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const changedSinceBase = () => {
  try {
    const mergeBase = git('merge-base', 'HEAD', BASE_REF)
    return git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean)
  } catch {
    return null
  }
}

const main = () => {
  if (process.env.RADIOSO_SKIP_PUSH_GATES === '1') {
    console.error('pre-push: gates skipped (RADIOSO_SKIP_PUSH_GATES=1).')
    return 0
  }

  const { gates, notes } = planPushGates({
    updates: parsePushUpdates(readFileSync(0, 'utf8')),
    headSha: git('rev-parse', 'HEAD'),
    changedFiles: changedSinceBase(),
    rootPath: ROOT,
    knipInstalled: existsSync(join(ROOT, 'node_modules/knip/bin/knip.js')),
  })
  for (const note of notes) console.error(`pre-push: ${note}`)

  const failed = []
  for (const name of gates) {
    const gate = GATES[name]
    console.error(`pre-push: ${gate.label}`)
    const run = spawnSync(process.execPath, [join(ROOT, gate.script), ...gate.args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
    if (run.status !== 0) failed.push(name)
  }
  if (failed.length === 0) return 0

  const dirty = git('status', '--porcelain', '--untracked-files=no') !== ''
  console.error(
    [
      '',
      `pre-push: blocked by the ${failed.join(' and ')} gate${failed.length > 1 ? 's' : ''}, which would fail CI the same way.`,
      'Fix what it reports above, commit, and push again. docs/code-quality-gates.md says what each finding means.',
      ...(dirty ? ['The gates read the working tree, which has uncommitted changes: commit or discard them first if they caused this.'] : []),
    ].join('\n'),
  )
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
