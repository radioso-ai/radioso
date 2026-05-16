import { describe, expect, it } from 'vitest'

import { getHomeDashboardRedirectHref } from '@/lib/home-dashboard-redirect'

describe('getHomeDashboardRedirectHref', () => {
  it('waits for workspace bootstrap instead of redirecting to a legacy dashboard route', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: true,
      activeWorkspace: null,
    })).toBeNull()
  })

  it('redirects authenticated users to the active workspace route', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: false,
      activeWorkspace: {
        id: 'workspace-1',
        publicRouteKey: 'support-abc123',
      },
    })).toBe('/w/support-abc123/agents')
  })
})
