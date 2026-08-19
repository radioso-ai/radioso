import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const archivePath = resolve(repoRoot, 'frontend/public/radioso-sync.zip')
const companionRoot = resolve(repoRoot, 'packages/wordpress-companion')
const pluginSource = readFileSync(resolve(companionRoot, 'radioso-sync.php'), 'utf8')

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

  it('records bounded resync activity and scheduling failures', () => {
    expect(pluginSource).toContain('RADIOSO_RESYNC_LOG_LIMIT')
    expect(pluginSource).toContain("'activity_log'")
    expect(pluginSource).toContain("'last_error'")
    expect(pluginSource).toMatch(/wp_schedule_single_event\([^;]+true\)/s)
    expect(pluginSource).toContain('is_wp_error($scheduled)')
  })

  it('exposes cron health and an admin-only manual batch action', () => {
    expect(pluginSource).toContain("admin_post_radioso_resync_run_now")
    expect(pluginSource).toContain("current_user_can('manage_options')")
    expect(pluginSource).toContain("check_admin_referer('radioso_resync_run_now')")
    expect(pluginSource).toContain("wp_next_scheduled('radioso_resync_batch')")
    expect(pluginSource).toContain('DISABLE_WP_CRON')
    expect(pluginSource).toContain('radioso_resync_acquire_lock')
    expect(pluginSource).toContain('Run next batch now')
  })

  it('captures fatal batch failures for the next settings-page load', () => {
    expect(pluginSource).toContain("register_shutdown_function('radioso_resync_capture_fatal')")
    expect(pluginSource).toContain('error_get_last()')
    expect(pluginSource).toContain("$state['status'] = 'failed'")
  })
})
