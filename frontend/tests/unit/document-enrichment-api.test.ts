import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentsApi } from '@/lib/api'

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

describe('document enrichment API adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a one-run enrichment override when reprocessing one document', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ documentId: 'doc-1', status: 'queued' }))
    vi.stubGlobal('fetch', fetchMock)

    await documentsApi.reprocessDocument('doc-1', { documentEnrichmentOverride: 'on' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/document/doc-1/reprocess',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ documentEnrichmentOverride: 'on' }),
      }),
    )
  })

  it('sends a one-run enrichment override when reprocessing one source', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      sourceId: 'source-1',
      workspaceId: 'workspace-1',
      queuedDocumentCount: 1,
      skippedDocumentCount: 0,
      status: 'queued',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await documentsApi.reprocessSource('source-1', { documentEnrichmentOverride: 'off' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/document/sources/source-1/reprocess',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ documentEnrichmentOverride: 'off' }),
      }),
    )
  })

  it('sends the source enrichment override patch separately from crawl settings', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ id: 'source-1', documentEnrichmentOverride: 'on' }))
    vi.stubGlobal('fetch', fetchMock)

    await documentsApi.updateSourceEnrichmentOverride('source-1', 'on')

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/document/sources/source-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ documentEnrichmentOverride: 'on' }),
      }),
    )
  })
})
