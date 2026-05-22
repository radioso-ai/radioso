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

  it('redirects authenticated users directly to the resolved agent when available', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: false,
      activeWorkspace: {
        id: 'workspace-1',
        publicRouteKey: 'support-abc123',
      },
      agentId: '67acb0c8-caad-4a1b-9fef-70cbca3f7d12',
    })).toBe('/w/support-abc123/agents/67acb0c8-caad-4a1b-9fef-70cbca3f7d12')
  })
})
