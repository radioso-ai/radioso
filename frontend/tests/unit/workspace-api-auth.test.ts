import { afterEach, describe, expect, it, vi } from 'vitest'

import { generalSettingsApi } from '@/lib/api'

const createLocalStorage = (seed: Record<string, string> = {}) => {
  const store = new Map(Object.entries(seed))

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

const createJsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  headers: {
    get: () => 'application/json',
  },
  json: async () => payload,
})

describe('workspace API auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses a cached workspace token as bearer auth for workspace-scoped requests', async () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
        'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'sk_proj_cached_token' }),
      }),
    })

    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        anonymousChatEnabled: false,
        anonymousRateLimit: 10,
        anonymousChatUrl: null,
        anonymousChatToken: null,
        assistantName: '',
        assistantRole: '',
        greetingInstruction: '',
        assistantDefaultLocale: null,
        proactiveGreetingEnabled: false,
        assistantBootstrapActive: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/settings/general')
    expect(requestInit.credentials).toBeUndefined()
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer sk_proj_cached_token')
  })

  it('bootstraps a workspace token with the session and then uses bearer auth', async () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-1',
    })
    vi.stubGlobal('window', { localStorage })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ token: 'sk_proj_fetched_token' }))
      .mockResolvedValueOnce(
        createJsonResponse({
          anonymousChatEnabled: false,
          anonymousRateLimit: 10,
          anonymousChatUrl: null,
          anonymousChatToken: null,
          assistantName: '',
          assistantRole: '',
          greetingInstruction: '',
          assistantDefaultLocale: null,
          proactiveGreetingEnabled: false,
          assistantBootstrapActive: false,
        }),
      )

    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe('/backend/api/v1/account/workspaces/workspace-1/token')
    expect(tokenInit.credentials).toBe('include')

    const [requestUrl, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/settings/general')
    expect(requestInit.credentials).toBeUndefined()
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer sk_proj_fetched_token')
    expect(localStorage.getItem('radioso.workspaceTokens')).toContain('workspace-1')
  })
})
