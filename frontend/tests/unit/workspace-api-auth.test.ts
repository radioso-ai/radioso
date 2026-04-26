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

const createErrorResponse = (status: number, payload: unknown) => ({
  ok: false,
  status,
  headers: {
    get: () => 'application/json',
  },
  json: async () => payload,
})

const platformSettingsPayload = {
  assistant: {
    assistantName: '',
    assistantRole: '',
    greetingInstruction: '',
    assistantDefaultLocale: null,
    proactiveGreetingEnabled: false,
    assistantBootstrapActive: false,
    conversationMode: 'guided',
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    customInstruction: '',
  },
  retrieval: {
    queryRewriteEnabled: false,
    semanticRewriteInstructions: '',
    lexicalRewriteInstructions: '',
    answerSupportPolicy: 'strict',
    rerankEnabled: false,
    vectorTopK: 15,
    similarityThreshold: 0.2,
    rerankTopK: 5,
    citationDisplayEnabled: true,
    metadataRules: [],
    metadataFieldSuggestions: [],
  },
  channels: {
    anonymousChatEnabled: false,
    anonymousRateLimit: 10,
    anonymousChatUrl: null,
    anonymousChatToken: null,
  },
}

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
      createJsonResponse(platformSettingsPayload),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/settings')
    expect(requestInit.credentials).toBe('omit')
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
        createJsonResponse(platformSettingsPayload),
      )

    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe('/backend/api/v1/account/workspaces/workspace-1/token')
    expect(tokenInit.credentials).toBe('include')

    const [requestUrl, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/settings')
    expect(requestInit.credentials).toBe('omit')
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer sk_proj_fetched_token')
    expect(localStorage.getItem('radioso.workspaceTokens')).toContain('workspace-1')
  })

  it('refreshes a stale cached workspace token after a bearer 401', async () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-1',
      'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'sk_proj_stale_token' }),
    })
    vi.stubGlobal('window', { localStorage })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createErrorResponse(401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid workspace token.',
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({ token: 'sk_proj_fresh_token' }))
      .mockResolvedValueOnce(
        createJsonResponse(platformSettingsPayload),
      )
    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/backend/api/v1/account/workspaces/workspace-1/token')
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe('Bearer sk_proj_fresh_token')
    expect(localStorage.getItem('radioso.workspaceTokens')).toContain('sk_proj_fresh_token')
  })
})
