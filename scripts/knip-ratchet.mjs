#!/usr/bin/env node
/**
 * Dead-code ratchet.
 *
 * knip reports far more dead code than one change can responsibly delete, so a plain
 * pass/fail gate would either block every PR or be switched off. This wraps it in two
 * rules instead:
 *
 *   1. A finding that is not in knip-baseline.json fails the build. New dead code cannot
 *      enter the repo, including dead code you created somewhere else by deleting the last
 *      caller of an export you never opened.
 *   2. A baselined finding in a file this change touches also fails the build. You are not
 *      asked to clean the whole repo, only the part you were already editing.
 *
 * The baseline only ever shrinks: `--update` re-records it, and dropped entries are
 * reported so the ratchet cannot silently be loosened.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'knip-baseline.json')

const args = process.argv.slice(2)
const shouldUpdate = args.includes('--update')
const baseRef = args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? 'origin/main'

/** Issue kinds worth gating. Dependency findings are reported but not gated: this repo
 *  drives several tools from shell scripts, which knip cannot read, so they are noisy. */
const GATED_KINDS = ['exports', 'types', 'nsExports', 'nsTypes', 'classMembers', 'enumMembers', 'duplicates']

const runKnip = () => {
  try {
    return execFileSync('node', [join(ROOT, 'node_modules/knip/bin/knip.js'), '--no-progress', '--reporter', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() },
    })
  } catch (error) {
    // knip exits non-zero whenever it reports anything, which is the normal case here.
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) return error.stdout
    throw error
  }
}

/** Stable across unrelated edits: line numbers churn, so they are deliberately not part of the key. */
const findingsFrom = (report) => {
  const found = new Map()
  for (const file of report.files ?? []) found.set(`files|${file}|`, { kind: 'files', file, name: '' })
  for (const issue of report.issues ?? []) {
    for (const kind of GATED_KINDS) {
      // knip's shapes vary by kind: a flat array, an array of duplicate-groups, or an
      // object keyed by the owning enum/class.
      const raw = issue[kind]
      if (!raw) continue
      const items = Array.isArray(raw) ? raw.flat() : Object.values(raw).flat()
      for (const item of items) {
        const name = typeof item === 'string' ? item : (item?.name ?? String(item))
        found.set(`${kind}|${issue.file}|${name}`, { kind, file: issue.file, name })
      }
    }
  }
  return found
}

const changedFiles = () => {
  try {
    const mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], { cwd: ROOT, encoding: 'utf8' }).trim()
    // Diff the merge base against the working tree, not against HEAD: locally the files you
    // are being asked to clean up are usually the ones you have not committed yet.
    const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', mergeBase], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return new Set([...changed.split('\n'), ...untracked.split('\n')].filter(Boolean))
  } catch {
    console.warn(`knip-ratchet: could not diff against ${baseRef}; skipping the touched-file rule.`)
    return null
  }
}

const report = JSON.parse(runKnip())
const found = findingsFrom(report)

if (shouldUpdate) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify([...found.keys()].sort(), null, 2)}\n`)
  console.log(`knip-ratchet: recorded ${found.size} findings in knip-baseline.json`)
  process.exit(0)
}

/**
 * Read the baseline as of the merge base, not the working tree. Otherwise a change could
 * exempt its own dead code by appending to the baseline in the same commit. On the change
 * that first introduces the baseline there is nothing to read, so the working-tree file is
 * the baseline by definition.
 */
const baselineAtMergeBase = () => {
  try {
    const mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], { cwd: ROOT, encoding: 'utf8' }).trim()
    const raw = execFileSync('git', ['show', `${mergeBase}:knip-baseline.json`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(JSON.parse(raw))
  } catch {
    return null
  }
}

const workingBaseline = new Set(existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : [])
const mergeBaseBaseline = baselineAtMergeBase()
const isBootstrap = mergeBaseBaseline === null
const baseline = mergeBaseBaseline ?? workingBaseline
const touched = changedFiles()

const added = [...found.entries()].filter(([key]) => !baseline.has(key))
// On the change that first records the baseline every finding is new to the baseline, so
// "you touched this file, clean it up" has nothing to point at yet. It starts applying to
// the next change, once the baseline exists at the merge base.
const inTouchedFile = touched && !isBootstrap
  ? [...found.entries()].filter(([key, f]) => baseline.has(key) && touched.has(f.file))
  : []
const resolved = [...baseline].filter((key) => !found.has(key))
const drifted = [...found.keys()].filter((key) => !workingBaseline.has(key)).length + [...workingBaseline].filter((key) => !found.has(key)).length

const describe = ([, f]) => `  ${f.file}${f.name ? ` → ${f.name}` : ''}  (${f.kind})`

if (drifted) {
  console.log(`knip-ratchet: knip-baseline.json is ${drifted} entry/entries out of date. Run \`pnpm run lint:dead-code:baseline\` and commit it.\n`)
}

if (resolved.length) {
  console.log(`knip-ratchet: ${resolved.length} baselined finding(s) are gone. Run \`pnpm run lint:dead-code:baseline\` to bank the cleanup.\n`)
}

let failed = false

if (added.length) {
  failed = true
  console.error(`knip-ratchet: ${added.length} new dead-code finding(s):\n`)
  added.forEach((f) => console.error(describe(f)))
  console.error('\nDelete it, or wire it up to something. If it is a false positive, teach knip.json about the entry point.\n')
}

if (inTouchedFile.length) {
  failed = true
  console.error(`knip-ratchet: ${inTouchedFile.length} known dead-code finding(s) in files this change touches:\n`)
  inTouchedFile.forEach((f) => console.error(describe(f)))
  console.error('\nYou are already editing these files, so clean them up here rather than growing the baseline.\n')
}

if (isBootstrap) {
  console.log('knip-ratchet: no baseline at the merge base, so this change is recording it. The touched-file rule starts with the next change.')
}

if (!failed) console.log(`knip-ratchet: clean (${found.size} finding(s), all baselined and untouched).`)
process.exit(failed ? 1 : 0)
