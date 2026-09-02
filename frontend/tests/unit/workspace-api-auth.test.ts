import { afterEach, describe, expect, it, vi } from 'vitest'

import { generalSettingsApi, workspaceApi } from '@/lib/api'
import { request } from '@/lib/api-client'

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

  it('uses the signed-in session for workspace-scoped requests without cached bearer auth', async () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
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
    expect(requestInit.credentials).toBe('include')
    expect(new Headers(requestInit.headers).get('Authorization')).toBeNull()
    expect(new Headers(requestInit.headers).get('X-Workspace-Id')).toBe('workspace-1')
  })

  it('defaults private transport to the signed-in session so an omitted adapter option cannot drop workspace auth', async () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({ 'radioso.activeWorkspaceId': 'workspace-1' }),
    })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await request('/document/', { method: 'GET' })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('include')
    expect(new Headers(init.headers).get('X-Workspace-Id')).toBe('workspace-1')
    expect(new Headers(init.headers).get('Authorization')).toBeNull()
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

  it('requests workspace summary with session workspace auth', async () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
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
    expect(requestInit.credentials).toBe('include')
    expect(new Headers(requestInit.headers).get('Authorization')).toBeNull()
    expect(new Headers(requestInit.headers).get('X-Workspace-Id')).toBe('workspace-1')
  })

  it('does not bootstrap a workspace token before a workspace-scoped request', async () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-1',
    })
    vi.stubGlobal('window', { localStorage })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(platformSettingsPayload))

    vi.stubGlobal('fetch', fetchMock)

    await generalSettingsApi.getGeneralSettings()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/settings')
    expect(requestInit.credentials).toBe('include')
    expect(new Headers(requestInit.headers).get('Authorization')).toBeNull()
    expect(new Headers(requestInit.headers).get('X-Workspace-Id')).toBe('workspace-1')
  })

  it('does not refresh or retry with a workspace token after a session 401', async () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-1',
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
    vi.stubGlobal('fetch', fetchMock)

    await expect(generalSettingsApi.getGeneralSettings()).rejects.toMatchObject({ status: 401 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
