#!/usr/bin/env node
/**
 * Installs the git pre-push hook that runs `scripts/pre-push-gates.mjs`. The root `prepare`
 * script runs this on every `pnpm install`, so a fresh clone or worktree gets the hook
 * without a separate step.
 *
 * The hook goes into the repository's shared hooks directory, which every worktree uses.
 * A pre-push hook that is already there is kept as `pre-push.local` and runs first, with
 * the same refs on stdin, so a personal hook keeps working alongside the gates. The
 * dispatcher calls the gate script from the worktree being pushed and does nothing on a
 * branch that predates it.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOOK_MARKER = 'radioso-push-gates'

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

/** `current` is the pre-push hook as found, `local` the chained `pre-push.local`; null when absent. */
export const planHookInstall = ({ current, local }) => {
  if (current === null || current.includes(HOOK_MARKER)) return { action: 'write', keepCurrentAsLocal: false }
  if (local === null) return { action: 'write', keepCurrentAsLocal: true }
  // The chained hook reinstalled itself over the dispatcher; pre-push.local already holds it.
  if (current === local) return { action: 'write', keepCurrentAsLocal: false }
  return {
    action: 'skip',
    reason: 'pre-push and pre-push.local are two different hooks, so neither was replaced. Merge them into pre-push.local and run `pnpm install` again.',
  }
}

/**
 * The chained hook's header comments are copied in, so a tool that recognises its own hook
 * by a marker comment still finds it.
 */
export const dispatcherScript = (localHook) => {
  const chainedHeader = (localHook ?? '')
    .split('\n')
    .filter((line) => line.startsWith('#') && !line.startsWith('#!'))
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER}: installed by scripts/install-git-hooks.mjs on \`pnpm install\`; edits here are overwritten.`,
    '# Runs pre-push.local first, then the repository gates from the worktree being pushed.',
    ...(chainedHeader.length > 0 ? ['# Chained hook (pre-push.local):', ...chainedHeader] : []),
    'hooks_dir=$(dirname "$0")',
    'updates=$(cat)',
    'if [ -x "$hooks_dir/pre-push.local" ]; then',
    '  printf \'%s\\n\' "$updates" | "$hooks_dir/pre-push.local" "$@" || exit $?',
    'fi',
    'gates="$(git rev-parse --show-toplevel)/scripts/pre-push-gates.mjs"',
    'if [ -f "$gates" ]; then',
    '  if command -v node >/dev/null 2>&1; then',
    '    printf \'%s\\n\' "$updates" | node "$gates" "$@" || exit $?',
    '  else',
    '    echo "pre-push: node is not on PATH, so the gates were skipped. CI runs them." >&2',
    '  fi',
    'fi',
    'exit 0',
    '',
  ].join('\n')
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const install = (cwd) => {
  let hooksDir
  try {
    hooksDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks')
  } catch {
    return // Not a git checkout, e.g. a Docker build context.
  }
  let customHooksPath = ''
  try {
    customHooksPath = git(cwd, 'config', '--get', 'core.hooksPath')
  } catch {
    // Unset, the usual case.
  }
  if (customHooksPath) {
    console.warn(`install-git-hooks: core.hooksPath is set to ${customHooksPath}; add scripts/pre-push-gates.mjs to that pre-push hook yourself.`)
    return
  }

  const hookPath = join(hooksDir, 'pre-push')
  const localPath = join(hooksDir, 'pre-push.local')
  const current = readIfPresent(hookPath)
  const plan = planHookInstall({ current, local: readIfPresent(localPath) })
  if (plan.action === 'skip') {
    console.warn(`install-git-hooks: ${plan.reason}`)
    return
  }
  if (plan.keepCurrentAsLocal) renameSync(hookPath, localPath)

  const script = dispatcherScript(readIfPresent(localPath))
  if (script === readIfPresent(hookPath)) return
  writeFileSync(hookPath, script)
  chmodSync(hookPath, 0o755)
  console.log(`install-git-hooks: pre-push gates installed in ${hookPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.CI) {
  try {
    install(process.cwd())
  } catch (error) {
    // Never fail `pnpm install` over a convenience hook.
    console.warn(`install-git-hooks: hook not installed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
