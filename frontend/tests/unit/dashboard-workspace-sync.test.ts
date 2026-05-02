import { describe, expect, it } from 'vitest'

import {
  shouldRewriteToActiveWorkspace,
  shouldWaitForRouteWorkspace,
} from '@/lib/dashboard-workspace-sync'

describe('dashboard workspace route sync', () => {
  it('does not wait or rewrite when the requested workspace is absent from the current workspace list', () => {
    const input = {
      activeWorkspaceId: 'old-workspace',
      requestedWorkspaceId: 'route-workspace',
      requestedWorkspaceExists: false,
    }

    expect(shouldWaitForRouteWorkspace(input)).toBe(false)
    expect(shouldRewriteToActiveWorkspace(input)).toBe(false)
  })

  it('allows the route-owned workspace switch when the workspace exists in the current list', () => {
    const input = {
      activeWorkspaceId: 'old-workspace',
      requestedWorkspaceId: 'route-workspace',
      requestedWorkspaceExists: true,
    }

    expect(shouldWaitForRouteWorkspace(input)).toBe(true)
    expect(shouldRewriteToActiveWorkspace(input)).toBe(true)
  })

  it('does not wait or rewrite when the active workspace already matches the route', () => {
    const input = {
      activeWorkspaceId: 'route-workspace',
      requestedWorkspaceId: 'route-workspace',
      requestedWorkspaceExists: true,
    }

    expect(shouldWaitForRouteWorkspace(input)).toBe(false)
    expect(shouldRewriteToActiveWorkspace(input)).toBe(false)
  })
})
