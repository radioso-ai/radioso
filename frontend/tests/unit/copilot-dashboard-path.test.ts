import { describe, expect, it } from 'vitest'

import { workspaceDashboardHref } from '@/lib/copilot-dashboard-path'

describe('workspaceDashboardHref', () => {
  it('opens a contributed proposal\'s page inside the workspace dashboard', () => {
    expect(workspaceDashboardHref('acme', '/settings?settingsTab=usage')).toBe('/w/acme/settings?settingsTab=usage')
  })

  it.each([
    ['a parent segment', '/../../login'],
    ['a percent-encoded parent segment', '/%2e%2e/%2E%2E/login'],
    ['a current segment before a parent one', '/./../w/other/agents'],
    ['another origin', '//elsewhere.example/settings'],
    ['a relative path', 'settings'],
    ['a backslash', '/\\elsewhere.example'],
  ])('refuses %s', (_case, dashboardPath) => {
    expect(workspaceDashboardHref('acme', dashboardPath)).toBeNull()
  })
})
