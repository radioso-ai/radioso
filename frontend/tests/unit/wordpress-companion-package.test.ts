import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const archivePath = resolve(repoRoot, 'frontend/public/radioso-sync.zip')
const companionRoot = resolve(repoRoot, 'packages/wordpress-companion')

const readArchiveEntry = (entry: string): string =>
  execFileSync('unzip', ['-p', archivePath, `radioso-sync/${entry}`], {
    encoding: 'utf8',
  })

describe('WordPress companion download', () => {
  it.each(['radioso-sync.php', 'README.md'])(
    'packages the current %s source instead of a stale copy',
    (filename) => {
      expect(readArchiveEntry(filename)).toBe(
        readFileSync(resolve(companionRoot, filename), 'utf8'),
      )
    },
  )
})
