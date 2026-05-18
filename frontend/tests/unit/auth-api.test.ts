import { afterEach, describe, expect, it, vi } from 'vitest'

import { authApi } from '@/lib/api'

const createJsonResponse = (payload: unknown, status = 200) => ({
  ok: true,
  status,
  headers: {
    get: () => 'application/json',
  },
  json: async () => payload,
})

describe('authApi auth email flows', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests password reset through the OSS auth API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ accepted: true }, 202))
    vi.stubGlobal('fetch', fetchMock)

    await expect(authApi.requestPasswordReset({ email: 'ada@example.com' }))
      .resolves.toEqual({ accepted: true })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/auth/password-reset/request',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'ada@example.com' }),
      }),
    )
  })

  it('confirms password reset with session credentials', async () => {
    const payload = {
      userId: 'user-1',
      accountId: 'account-1',
      email: 'ada@example.com',
      organizationName: 'Ada Organization',
      workspaceId: 'workspace-1',
      workspaceName: 'Default',
      workspacePublicRouteKey: '1234567890',
    }
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(authApi.confirmPasswordReset({ token: 'token-1', password: 'new-password' }))
      .resolves.toEqual(payload)

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/auth/password-reset/confirm',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ token: 'token-1', password: 'new-password' }),
      }),
    )
  })

  it('verifies and resends email verification through OSS auth endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({ verified: true }))
      .mockResolvedValueOnce(createJsonResponse({ accepted: true }, 202))
    vi.stubGlobal('fetch', fetchMock)

    await expect(authApi.verifyEmail({ token: 'verify-token' })).resolves.toEqual({ verified: true })
    await expect(authApi.resendEmailVerification({ email: 'ada@example.com' })).resolves.toEqual({ accepted: true })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/backend/api/v1/auth/email-verification/verify',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/backend/api/v1/auth/email-verification/resend',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
