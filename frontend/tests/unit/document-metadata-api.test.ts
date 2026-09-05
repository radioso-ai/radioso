import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentsApi } from '@/lib/api'

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

const stubTransport = (payload: unknown) => {
  vi.stubGlobal('window', { localStorage: createLocalStorage() })
  const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(payload))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const jsonBodyOf = (fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const [, requestInit] = fetchMock.mock.calls[0] as [string, { body: string }]
  return JSON.parse(requestInit.body) as Record<string, unknown>
}

const formDataOf = (fetchMock: ReturnType<typeof vi.fn>): FormData => {
  const [, requestInit] = fetchMock.mock.calls[0] as [string, { body: FormData }]
  return requestInit.body
}

describe('document metadata API adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serializes import tags into a single "metadata" form field', async () => {
    const fetchMock = stubTransport({ documentId: 'doc-1', status: 'queued' })
    const file = new File(['hello'], 'guide.md', { type: 'text/markdown' })

    await documentsApi.importDocument(file, 'Guide', {
      metadata: { region: 'emea', capacity: 42, archived: true },
    })

    const formData = formDataOf(fetchMock)
    expect(JSON.parse(formData.get('metadata') as string)).toMatchObject({
      region: 'emea',
      capacity: 42,
      archived: true,
    })
    expect(formData.get('title')).toBe('Guide')
  })

  it('leaves the "metadata" form field out when there are no tags to send', async () => {
    const fetchMock = stubTransport({ documentId: 'doc-1', status: 'queued' })
    const file = new File(['hello'], 'guide.md', { type: 'text/markdown' })

    await documentsApi.importDocument(file, undefined, { metadata: {} })

    expect(formDataOf(fetchMock).get('metadata')).toBeNull()
  })

  it('carries import tags alongside a one-run enrichment override', async () => {
    const fetchMock = stubTransport({ documentId: 'doc-1', status: 'queued' })
    const file = new File(['hello'], 'guide.md', { type: 'text/markdown' })

    await documentsApi.importDocument(file, undefined, {
      documentEnrichmentOverride: 'off',
      metadata: { region: 'emea' },
    })

    const formData = formDataOf(fetchMock)
    expect(formData.get('documentEnrichmentOverride')).toBe('off')
    expect(JSON.parse(formData.get('metadata') as string)).toMatchObject({ region: 'emea' })
  })

  it('patches a document with the full replacement tag set', async () => {
    const fetchMock = stubTransport({ id: 'doc-1', metadata: { region: 'emea' } })

    await documentsApi.updateDocumentMetadata('doc-1', { region: 'emea', capacity: 42 })

    const [url, requestInit] = fetchMock.mock.calls[0] as [string, { method: string }]
    expect(url).toBe('/backend/api/v1/document/doc-1')
    expect(requestInit.method).toBe('PATCH')
    expect(jsonBodyOf(fetchMock)).toMatchObject({ metadata: { region: 'emea', capacity: 42 } })
  })

  it('sends an empty tag set on the document patch, which is how tags are cleared', async () => {
    const fetchMock = stubTransport({ id: 'doc-1', metadata: {} })

    await documentsApi.updateDocumentMetadata('doc-1', {})

    expect(jsonBodyOf(fetchMock)).toEqual({ metadata: {} })
  })

  it('patches a source with documentMetadata only, leaving other source settings alone', async () => {
    const fetchMock = stubTransport({ id: 'source-1', documentMetadata: { department: 'engineering' } })

    await documentsApi.updateSourceDocumentMetadata('source-1', { department: 'engineering', priority: 1 })

    const [url, requestInit] = fetchMock.mock.calls[0] as [string, { method: string }]
    expect(url).toBe('/backend/api/v1/document/sources/source-1')
    expect(requestInit.method).toBe('PATCH')

    const body = jsonBodyOf(fetchMock)
    expect(body).toMatchObject({ documentMetadata: { department: 'engineering', priority: 1 } })
    expect(body).not.toHaveProperty('documentEnrichmentOverride')
    expect(body).not.toHaveProperty('crawlSettings')
  })

  it('sends an empty source tag template, which is how the template is cleared', async () => {
    const fetchMock = stubTransport({ id: 'source-1', documentMetadata: {} })

    await documentsApi.updateSourceDocumentMetadata('source-1', {})

    expect(jsonBodyOf(fetchMock)).toEqual({ documentMetadata: {} })
  })
})
