import { afterEach, describe, expect, it, vi } from 'vitest'

import { authApi } from '@/lib/api'

const createJsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => payload,
})

const createErrorResponse = (status: number) => ({
  ok: false,
  status,
  headers: { get: () => 'application/json' },
  json: async () => ({ error: { code: 'not_found', message: 'not found' } }),
})

describe('Google login API adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the provider as enabled when the EE status endpoint says so', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ enabled: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(authApi.getGoogleLoginStatus()).resolves.toEqual({ enabled: true })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/backend/api/v1/ee/auth/google/status')
  })

  it('degrades to disabled when the EE module is absent (404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createErrorResponse(404)))

    await expect(authApi.getGoogleLoginStatus()).resolves.toEqual({ enabled: false })
  })

  it('degrades to disabled when the probe rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    await expect(authApi.getGoogleLoginStatus()).resolves.toEqual({ enabled: false })
  })

  it('points the sign-in button at the same-origin EE start endpoint', () => {
    expect(authApi.getGoogleLoginStartUrl()).toBe('/backend/api/v1/ee/auth/google/start')
  })

  it('carries a same-origin relative return target into Google sign-in', () => {
    expect(authApi.getGoogleLoginStartUrl('/oauth/operator-mcp/consent?transaction=tx-1')).toBe(
      '/backend/api/v1/ee/auth/google/start?return_to=%2Foauth%2Foperator-mcp%2Fconsent%3Ftransaction%3Dtx-1',
    )
  })

  it.each(['https://attacker.example/steal', '//attacker.example/steal', '/\\attacker.example/steal'])(
    'does not put an external return target into the Google start URL: %s',
    (returnTo) => {
      expect(authApi.getGoogleLoginStartUrl(returnTo)).toBe(
        '/backend/api/v1/ee/auth/google/start',
      )
    },
  )
})
