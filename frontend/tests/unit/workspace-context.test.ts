import { describe, expect, it } from 'vitest'

import { resolveBootstrapWorkspaceId, shouldLogoutAfterWorkspaceBootstrapError } from '@/lib/workspace-context'

const workspace = (id: string, name: string) => ({
  id,
  accountId: 'account-1',
  name,
  publicRouteKey: `${name.toLowerCase()}-${id}`,
  createdAt: '2026-04-11T00:00:00.000Z',
  updatedAt: '2026-04-11T00:00:00.000Z',
})

describe('resolveBootstrapWorkspaceId', () => {
  it('prefers the stored workspace when it is still available', () => {
    expect(resolveBootstrapWorkspaceId([
      workspace('workspace-1', 'Teataja'),
      workspace('workspace-2', 'Ananda'),
    ], 'workspace-1')).toBe('workspace-1')
  })

  it('falls back to the default workspace when no stored workspace is present', () => {
    expect(resolveBootstrapWorkspaceId([
      workspace('workspace-1', 'Teataja'),
      workspace('workspace-2', 'Default'),
      workspace('workspace-3', 'Ananda'),
    ], null)).toBe('workspace-2')
  })

  it('otherwise falls back to the newest workspace in the list', () => {
    expect(resolveBootstrapWorkspaceId([
      workspace('workspace-1', 'Teataja'),
      workspace('workspace-2', 'Ananda'),
    ], null)).toBe('workspace-2')
  })
})

describe('shouldLogoutAfterWorkspaceBootstrapError', () => {
  it('keeps the session when workspace bootstrap fails without proving it is unauthorized', () => {
    expect(shouldLogoutAfterWorkspaceBootstrapError({ status: 500 })).toBe(false)
    expect(shouldLogoutAfterWorkspaceBootstrapError(new Error('network unavailable'))).toBe(false)
  })

  it('logs out when workspace bootstrap receives an unauthorized response', () => {
    expect(shouldLogoutAfterWorkspaceBootstrapError({ status: 401 })).toBe(true)
  })
})
