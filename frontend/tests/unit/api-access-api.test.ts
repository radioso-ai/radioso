import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiAccessApi } from '@/lib/api-api-access'

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => payload,
})

describe('apiAccessApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the session, workspace selection, and non-simple CSRF header for the summary', async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => key === 'radioso.activeWorkspaceId' ? 'workspace-1' : null },
      document: { cookie: 'radioso_csrf_token=csrf-123' },
    })
    vi.stubGlobal('document', { cookie: 'radioso_csrf_token=csrf-123', querySelector: () => null })
    const fetchMock = vi.fn().mockResolvedValue(response({
      effectiveRole: 'member',
      capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: false, manageServiceAccounts: false },
      defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
      limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
      legacyCredentialMigration: { status: 'destroyed', migratedAt: '2026-08-31T00:00:00.000Z' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await apiAccessApi.getSummary('workspace-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/account/workspaces/workspace-1/api-access',
      expect.objectContaining({ credentials: 'include' }),
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('X-Workspace-Id')).toBe('workspace-1')
    expect(headers.get('X-Radioso-CSRF')).toBe('1')
    expect(headers.get('Authorization')).toBeNull()
  })

  it('maps paginated personal-token requests without persisting the one-time secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ items: [], page: 2, limit: 50, total: 0 }))
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'workspace-1' },
      document: { cookie: '' },
    })
    vi.stubGlobal('fetch', fetchMock)

    const page = await apiAccessApi.listPersonalTokens('workspace-1', { view: 'mine', page: 2, limit: 50 })
    expect(page).toEqual({ items: [], page: 2, limit: 50, total: 0 })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/backend/api/v1/account/workspaces/workspace-1/api-access/personal-tokens?view=mine&page=2&limit=50',
    )

    await apiAccessApi.createPersonalToken('workspace-1', {
      label: 'CLI',
      roleCeiling: 'member',
      expiresAt: '2026-11-29T23:59:59.000Z',
    })
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ credentials: 'include' }))
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('Authorization')
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-Radioso-CSRF')).toBe('1')
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      label: 'CLI',
      roleCeiling: 'member',
      expiresAt: '2026-11-29T23:59:59.000Z',
    })
  })

  it('sends observed revisions for destructive and concurrent-safe lifecycle operations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 'credential-1', revision: 4 }))
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'workspace-1' },
      document: { cookie: '' },
    })
    vi.stubGlobal('fetch', fetchMock)

    await apiAccessApi.rotatePersonalToken('workspace-1', 'credential-1', 3)
    await apiAccessApi.revokeServiceCredential('workspace-1', 'service-1', 'credential-1')

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ revision: 3 })
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/personal-tokens/credential-1/rotate')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/service-accounts/service-1/credentials/credential-1/revoke')
  })
})
