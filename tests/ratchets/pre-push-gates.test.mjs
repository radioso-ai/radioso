import test from 'node:test'
import assert from 'node:assert/strict'

import { parsePushUpdates, planPushGates } from '../../scripts/pre-push-gates.mjs'
import { HOOK_MARKER, dispatcherScript, planHookInstall } from '../../scripts/install-git-hooks.mjs'

const HEAD = 'a'.repeat(40)
const ZERO = '0'.repeat(40)
const update = (localSha = HEAD) => ({ localRef: 'refs/heads/topic', localSha, remoteRef: 'refs/heads/topic', remoteSha: ZERO })
const plan = (overrides = {}) =>
  planPushGates({
    updates: [update()],
    headSha: HEAD,
    changedFiles: ['backend/src/app.ts'],
    rootPath: '/work/radioso',
    knipInstalled: true,
    ...overrides,
  })

test('reads the refs git hands the hook and drops branch deletions', () => {
  const stdin = [
    `refs/heads/topic ${HEAD} refs/heads/topic ${ZERO}`,
    `(delete) ${ZERO} refs/heads/old ${'b'.repeat(40)}`,
    '',
  ].join('\n')

  assert.deepEqual(parsePushUpdates(stdin), [update()])
})

test('a code change runs both gates', () => {
  assert.deepEqual(plan().gates, ['file-size', 'dead-code'])
})

test('a change with no code skips the dead-code gate but still checks file sizes', () => {
  assert.deepEqual(plan({ changedFiles: ['docs/releases.md', 'infra/terraform/main.tf'] }).gates, ['file-size'])
})

test('a lockfile, manifest, or baseline change counts as a dead-code input', () => {
  for (const file of ['pnpm-lock.yaml', 'packages/ui/package.json', 'knip-baseline.json', 'scripts/tool.mjs', 'frontend/app/page.tsx']) {
    assert.deepEqual(plan({ changedFiles: [file] }).gates, ['file-size', 'dead-code'], file)
  }
})

test('pushing only deletions runs nothing', () => {
  assert.deepEqual(plan({ updates: [] }).gates, [])
})

test('pushing a commit other than the checked-out one runs nothing, because the gates read the working tree', () => {
  const result = plan({ updates: [update('c'.repeat(40))] })

  assert.deepEqual(result.gates, [])
  assert.match(result.notes.join('\n'), /checked out/)
})

test('without installed dependencies the dead-code gate is skipped with a note, never a block', () => {
  const result = plan({ knipInstalled: false })

  assert.deepEqual(result.gates, ['file-size'])
  assert.match(result.notes.join('\n'), /pnpm install/)
})

test('a checkout under a dot directory skips the dead-code gate, which knip misreads there', () => {
  for (const rootPath of ['/work/radioso/.context/wt-1', '/work/radioso/.claude/worktrees/agent-1']) {
    const result = plan({ rootPath })

    assert.deepEqual(result.gates, ['file-size'], rootPath)
    assert.match(result.notes.join('\n'), /dot directory/)
  }
})

test('an unknown merge base skips the dead-code gate with a note', () => {
  const result = plan({ changedFiles: null })

  assert.deepEqual(result.gates, ['file-size'])
  assert.match(result.notes.join('\n'), /origin\/main/)
})

test('installs the dispatcher where no pre-push hook exists', () => {
  assert.deepEqual(planHookInstall({ current: null, local: null }), { action: 'write', keepCurrentAsLocal: false })
})

test('refreshes its own dispatcher in place', () => {
  assert.deepEqual(planHookInstall({ current: `#!/bin/sh\n# ${HOOK_MARKER}\n`, local: '#!/bin/sh\n' }), {
    action: 'write',
    keepCurrentAsLocal: false,
  })
})

test('keeps an existing hook as pre-push.local and chains it', () => {
  assert.deepEqual(planHookInstall({ current: '#!/bin/sh\nexec other-hook\n', local: null }), {
    action: 'write',
    keepCurrentAsLocal: true,
  })
})

test('a hook that reinstalled itself over the dispatcher is already kept, so the dispatcher goes back', () => {
  const other = '#!/bin/sh\nexec other-hook\n'

  assert.deepEqual(planHookInstall({ current: other, local: other }), { action: 'write', keepCurrentAsLocal: false })
})

test('two different foreign hooks are left alone rather than overwritten', () => {
  assert.equal(planHookInstall({ current: '#!/bin/sh\nexec one\n', local: '#!/bin/sh\nexec two\n' }).action, 'skip')
})

test('the dispatcher carries the chained hook’s header comments, so tools that look for their marker still find it', () => {
  const script = dispatcherScript('#!/bin/sh\n# other-guard: refuses risky pushes.\nexec other-guard "$@"\n')

  assert.match(script, new RegExp(HOOK_MARKER))
  assert.match(script, /# other-guard: refuses risky pushes\./)
  assert.doesNotMatch(script, /exec other-guard/)
})

test('the dispatcher skips the gates instead of blocking when node is missing, as in a GUI git client', () => {
  assert.match(dispatcherScript(null), /command -v node/)
})
