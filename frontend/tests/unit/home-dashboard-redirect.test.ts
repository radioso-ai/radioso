import { describe, expect, it } from 'vitest'

import { getHomeDashboardRedirectHref } from '@/lib/home-dashboard-redirect'

describe('getHomeDashboardRedirectHref', () => {
  it('waits for workspace bootstrap instead of redirecting to a legacy dashboard route', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: true,
      activeWorkspace: null,
      section: 'activity',
    })).toBeNull()
  })

  it('redirects a workspace that still needs onboarding to the agent chat tab', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: false,
      activeWorkspace: {
        id: 'workspace-1',
        publicRouteKey: 'support-abc123',
      },
      section: 'agents',
    })).toBe('/w/support-abc123/agents')
  })

  it('redirects a workspace that still needs onboarding directly to the resolved agent when available', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: false,
      activeWorkspace: {
        id: 'workspace-1',
        publicRouteKey: 'support-abc123',
      },
      section: 'agents',
      agentId: '67acb0c8-caad-4a1b-9fef-70cbca3f7d12',
    })).toBe('/w/support-abc123/agents/67acb0c8-caad-4a1b-9fef-70cbca3f7d12')
  })

  it('redirects a workspace that does not need onboarding to the Inbox — the normal landing section', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: false,
      activeWorkspace: {
        id: 'workspace-1',
        publicRouteKey: 'support-abc123',
      },
      section: 'activity',
    })).toBe('/w/support-abc123/activity')
  })

  it('ignores a resolved agentId when landing on the Inbox — it only applies to the agents section', () => {
    expect(getHomeDashboardRedirectHref({
      accountId: 'account-1',
      isAuthBootstrapping: false,
      isWorkspaceLoading: false,
      activeWorkspace: {
        id: 'workspace-1',
        publicRouteKey: 'support-abc123',
      },
      section: 'activity',
      agentId: '67acb0c8-caad-4a1b-9fef-70cbca3f7d12',
    })).toBe('/w/support-abc123/activity')
  })
})
