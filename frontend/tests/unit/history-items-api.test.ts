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

    const response = await chatApi.listHistory({ limit: 50, offset: 100 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/history?limit=50&offset=100',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(response.items).toEqual([])
  })

  it('normalizes changed chat history responses for the merged history view', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        conversations: [
          {
            id: 'conversation-1',
            preview: 'What records does history use?',
            sourceChannel: null,
            sourceOrigin: null,
            createdAt: '2026-04-26T12:00:00.000Z',
            updatedAt: '2026-04-26T12:05:00.000Z',
            messageCount: 2,
            userMessageCount: 1,
            assistantMessageCount: 1,
          },
        ],
        total: 1,
        nextCursor: null,
        hasMore: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(chatApi.listHistory({ limit: 50, offset: 0 })).resolves.toMatchObject({
      items: [
        {
          kind: 'chat',
          id: 'conversation-1',
          sortAt: '2026-04-26T12:05:00.000Z',
          conversation: {
            id: 'conversation-1',
          },
        },
      ],
      total: 1,
      nextCursor: null,
      hasMore: false,
    })
  })

  it('requests filtered chat history with offset pagination and ownership scope', async () => {
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

    await chatApi.listChatHistory({ limit: 50, offset: 100, ownership: 'human_owned' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/history/chat?limit=50&offset=100&ownership=human_owned',
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
