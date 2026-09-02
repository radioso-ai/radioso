import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentsApi, settingsApi, type IngestionSettings } from '@/lib/api'

const createLocalStorage = () => {
  const store = new Map<string, string>([
    ['radioso.activeWorkspaceId', 'workspace-1'],
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

  it('sends the manually added document override in the ingestion settings update body', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const settings: IngestionSettings = {
      workspaceId: 'workspace-1',
      chunkingStrategy: 'fixed_window',
      fixedWindowChunkSize: 1000,
      fixedWindowChunkOverlap: 200,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 1200,
      embeddingModel: 'text-embedding-3-small',
      pendingEmbeddingModel: null,
      documentEnrichmentEnabled: false,
      manualDocumentEnrichmentOverride: 'on',
      supportedEmbeddingModels: ['text-embedding-3-small'],
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(settings))
    vi.stubGlobal('fetch', fetchMock)

    await settingsApi.updateIngestionSettings(settings)

    const [, requestInit] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(JSON.parse(requestInit.body)).toMatchObject({
      manualDocumentEnrichmentOverride: 'on',
      documentEnrichmentEnabled: false,
    })
  })
})
