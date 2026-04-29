import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatApi, documentsApi } from '@/lib/api'

const createLocalStorage = () => {
  const store = new Map<string, string>([
    ['radioso.activeWorkspaceId', 'workspace-1'],
    ['radioso.workspaceTokens', JSON.stringify({ 'workspace-1': 'workspace-token' })],
  ])

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

describe('offset-backed list APIs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the merged history items with offset pagination', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        items: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await chatApi.listHistory({ limit: 50, offset: 100 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/history?limit=50&offset=100',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('requests filtered chat history with offset pagination', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        conversations: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await chatApi.listChatHistory({ limit: 50, offset: 100 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/history/chat?limit=50&offset=100',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('requests filtered search history with offset pagination', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        searches: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await chatApi.listSearchHistory({ limit: 50, offset: 50 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/history/search?limit=50&offset=50',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('requests document pages with offset pagination', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        documents: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await documentsApi.listDocuments({ limit: 100, offset: 200 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/document/?limit=100&offset=200',
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
