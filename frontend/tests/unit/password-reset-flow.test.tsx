import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { authApi } from '@/lib/api'
import { LoginForm } from '@/components/auth/login-form'

describe('password reset auth flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls the password reset request endpoint with session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ accepted: true }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const response = await authApi.requestPasswordReset({ email: 'user@example.com' })

    expect(response).toEqual({ accepted: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/auth/password-reset/request',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })

  it('renders a forgot-password entry point from the login form', () => {
    const markup = renderToStaticMarkup(<LoginForm onSwitchToRegister={() => undefined} />)

    expect(markup).toContain('Forgot password?')
  })
})
