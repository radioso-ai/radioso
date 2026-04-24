import { afterEach, describe, expect, it, vi } from 'vitest'

import { accountApi } from '@/lib/api'

describe('accountApi.getWorkspaceToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reveals the workspace token with session credentials and no bearer storage dependency', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ token: 'sk_proj_test_token' }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await accountApi.getWorkspaceToken('workspace-123')

    expect(response).toEqual({ token: 'sk_proj_test_token' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/workspaces/workspace-123/token',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
      }),
    )
  })

  it('creates invitations with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({
        id: 'invite-1',
        email: 'teammate@example.com',
        status: 'pending',
        expiresAt: '2026-04-16T00:00:00.000Z',
        acceptedAt: null,
        createdAt: '2026-04-09T00:00:00.000Z',
        acceptanceUrl: '/invite/token-1',
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await accountApi.createInvitation('teammate@example.com')

    expect(response.acceptanceUrl).toBe('/invite/token-1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/invitations',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })

  it('removes account users with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: {
        get: () => null,
      },
    })

    vi.stubGlobal('fetch', fetchMock)

    await accountApi.removeUser('membership-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/users/membership-1',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'include',
      }),
    )
  })

  it('lists accessible accounts with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({
        currentAccountId: 'account-1',
        accounts: [
          {
            accountId: 'account-1',
            organizationName: 'Acme',
            role: 'owner',
            workspaceId: 'workspace-1',
            workspaceName: 'Default',
            workspacePublicRouteKey: 'default-abc123',
          },
        ],
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await accountApi.listAccounts()

    expect(response.currentAccountId).toBe('account-1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/accounts',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
      }),
    )
  })

  it('switches account with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({
        userId: 'user-1',
        accountId: 'account-2',
        organizationName: 'Shared Org',
        workspaceId: 'workspace-2',
        workspaceName: 'Shared',
        workspacePublicRouteKey: 'shared-abc123',
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await accountApi.switchAccount('account-2', 'workspace-2')

    expect(response.accountId).toBe('account-2')
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/switch',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })

  it('creates organizations with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({
        userId: 'user-1',
        accountId: 'account-3',
        organizationName: 'Third Org',
        workspaceId: 'workspace-3',
        workspaceName: 'Default',
        workspacePublicRouteKey: 'default-def456',
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await accountApi.createOrganization('Third Org')

    expect(response.organizationName).toBe('Third Org')
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/accounts',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })

  it('renames organizations with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({
        accountId: 'account-1',
        organizationName: 'Renamed Org',
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await accountApi.renameOrganization('Renamed Org')

    expect(response.organizationName).toBe('Renamed Org')
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
      }),
    )
  })
})
