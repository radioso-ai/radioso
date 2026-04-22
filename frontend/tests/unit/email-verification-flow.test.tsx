import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { authApi } from '@/lib/api'
import { VerifyEmailScreen } from '@/components/auth/verify-email-screen'

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

  it('renders a fallback state when the verification token is missing', () => {
    const markup = renderToStaticMarkup(<VerifyEmailScreen />)

    expect(markup).toContain('Verify your email')
    expect(markup).toContain('Verification link is missing or incomplete.')
  })
})
