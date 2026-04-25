import { afterEach, describe, expect, it, vi } from 'vitest'

import { authApi } from '@/lib/api'

describe('email verification auth flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls the resend verification endpoint with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ accepted: true }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await authApi.resendVerificationEmail({ email: 'user@example.com' })

    expect(response).toEqual({ accepted: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/auth/email-verification/resend',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })

  it('calls the verify endpoint with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ verified: true }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await authApi.verifyEmail({ token: 'token-123' })

    expect(response).toEqual({ verified: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/auth/email-verification/verify',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })
})
