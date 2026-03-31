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
})
