import { afterEach, describe, expect, it, vi } from 'vitest'

import { generalSettingsApi, workspaceApi } from '@/lib/api'

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
    greetingInstruction: '',
    assistantDefaultLocale: null,
    proactiveGreetingEnabled: false,
    assistantBootstrapActive: false,
    suggestedQuestionsEnabled: true,
    customInstruction: '',
  },
  retrieval: {
    queryRewriteEnabled: false,
    semanticRewriteInstructions: '',
    lexicalRewriteInstructions: '',
    rerankEnabled: false,
    vectorTopK: 15,
    similarityThreshold: 0.2,
    rerankTopK: 5,
    metadataRules: [],
    metadataFieldSuggestions: [],
  },
  channels: {
    anonymousChatEnabled: false,
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
        'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'radioso_cached_token' }),
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
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer radioso_cached_token')
  })

  it('can load general settings with session auth and active workspace context', async () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
      }),
    })

    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse(platformSettingsPayload),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings({ auth: 'session' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(requestInit.headers)
    expect(requestUrl).toBe('/backend/api/v1/settings')
    expect(requestInit.credentials).toBe('include')
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('X-Workspace-Id')).toBe('workspace-1')
  })

  it('requests workspace summary with bearer workspace auth', async () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
        'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'radioso_cached_token' }),
      }),
    })

    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        documentCount: 0,
        readyDocumentCount: 0,
        pendingDocumentCount: 0,
        sampleDocumentCount: 0,
        sampleDocumentSlugs: [],
        conversationCount: 0,
        hasDocuments: false,
        hasPendingDocuments: false,
        hasReadyDocuments: false,
        hasCompletedChat: false,
        sampleDocumentsImported: false,
        websiteCrawlerEnabled: true,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await workspaceApi.getSummary()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/workspace/summary')
    expect(requestInit.credentials).toBe('omit')
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer radioso_cached_token')
  })

  it('bootstraps a workspace token with the session and then uses bearer auth', async () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-1',
    })
    vi.stubGlobal('window', { localStorage })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ token: 'radioso_fetched_token' }))
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
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer radioso_fetched_token')
    expect(localStorage.getItem('radioso.workspaceTokens')).toContain('workspace-1')
  })

  it('refreshes a stale cached workspace token after a bearer 401', async () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-1',
      'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'radioso_stale_token' }),
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
      .mockResolvedValueOnce(createJsonResponse({ token: 'radioso_fresh_token' }))
      .mockResolvedValueOnce(
        createJsonResponse(platformSettingsPayload),
      )
    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/backend/api/v1/account/workspaces/workspace-1/token')
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe('Bearer radioso_fresh_token')
    expect(localStorage.getItem('radioso.workspaceTokens')).toContain('radioso_fresh_token')
  })
})
