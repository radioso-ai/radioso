// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentsApi } from '@/lib/api'
import {
  documentCrawlPollingInterval,
  documentListPollingInterval,
  effectiveCrawlPresentation,
  fetchDocumentCrawlActivity,
  fetchDocumentList,
  hasAuthoritativeActiveCrawl,
  hasAuthoritativeActiveDocument,
  isInitialDocumentListLoading,
  patchDocumentListRow,
  removeDocumentListRow,
  useDocumentCrawlActivityQuery,
  useDocumentListQuery,
} from '@/lib/documents-query-state'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.restoreAllMocks())

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function DocumentProbe({ enabled, sourceId, workspaceId, optimistic }: {
  enabled: boolean
  optimistic: readonly { id: string; status: string }[]
  sourceId: string | null
  workspaceId: string
}) {
  useDocumentListQuery({ enabled, intervalMs: 45_000, sourceId, workspaceId, page: 1, pageSize: 25 })
  useDocumentCrawlActivityQuery({ enabled, floorMs: 45_000, workspaceId, optimisticJobs: optimistic as never })
  return null
}

const renderProbe = async (client: QueryClient, props: Parameters<typeof DocumentProbe>[0]) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(DocumentProbe, props)))
  })
  return root
}

describe('document query state', () => {
  it('uses one signal for recent and paused crawl requests and dedupes by job id', async () => {
    const signal = new AbortController().signal
    const recent = vi.spyOn(documentsApi, 'listCrawlJobs').mockResolvedValueOnce({ jobs: [
      { id: 'a', status: 'queued' }, { id: 'duplicate', status: 'processing' },
    ] } as never).mockResolvedValueOnce({ jobs: [
      { id: 'duplicate', status: 'paused' }, { id: 'b', status: 'paused' },
    ] } as never)

    await expect(fetchDocumentCrawlActivity(signal)).resolves.toMatchObject([
      { id: 'a' }, { id: 'duplicate', status: 'paused' }, { id: 'b' },
    ])
    expect(recent).toHaveBeenNthCalledWith(1, { sinceMinutes: 30 }, signal)
    expect(recent).toHaveBeenNthCalledWith(2, { status: 'paused' }, signal)
    recent.mockRestore()
  })

  it('uses only authoritative queued and processing jobs for the fast cadence', () => {
    expect(hasAuthoritativeActiveCrawl([{ status: 'paused' }] as never)).toBe(false)
    expect(hasAuthoritativeActiveCrawl([{ status: 'queued' }] as never)).toBe(true)
    expect(hasAuthoritativeActiveCrawl([{ status: 'processing' }] as never)).toBe(true)
    expect(documentCrawlPollingInterval([{ status: 'queued' }] as never, 45_000)).toBe(2_000)
    expect(documentCrawlPollingInterval([{ status: 'paused' }] as never, 45_000)).toBe(45_000)
    const optimistic = [{ id: 'optimistic', status: 'queued' }] as never
    expect(effectiveCrawlPresentation('workspace-a', 'workspace-b', optimistic)).toEqual([])
    expect(documentCrawlPollingInterval(
      effectiveCrawlPresentation('workspace-a', 'workspace-a', optimistic),
      45_000,
    )).toBe(2_000)
  })

  it('keeps visible queued and processing documents on the fast fallback cadence', () => {
    expect(hasAuthoritativeActiveDocument([{ status: 'ready' }] as never)).toBe(false)
    expect(hasAuthoritativeActiveDocument([{ status: 'failed' }] as never)).toBe(false)
    expect(hasAuthoritativeActiveDocument([{ id: 'optimistic-without-status' }] as never)).toBe(false)
    expect(hasAuthoritativeActiveDocument([{ status: 'queued' }] as never)).toBe(true)
    expect(hasAuthoritativeActiveDocument([{ status: 'PROCESSING' }] as never)).toBe(true)
    expect(documentListPollingInterval([{ status: 'queued' }] as never, 45_000)).toBe(2_000)
    expect(documentListPollingInterval([{ status: 'ready' }] as never, 45_000)).toBe(45_000)
  })

  it('fetches all and source lists with exact offset, limit, and the query signal', async () => {
    const signal = new AbortController().signal
    const all = vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue({} as never)
    const source = vi.spyOn(documentsApi, 'listSourceDocuments').mockResolvedValue({} as never)
    await fetchDocumentList({ signal, sourceId: null, page: 3, pageSize: 25 })
    await fetchDocumentList({ signal, sourceId: 'source-a', page: 2, pageSize: 50 })
    expect(all).toHaveBeenCalledWith({ limit: 25, offset: 50 }, signal)
    expect(source).toHaveBeenCalledWith('source-a', { limit: 50, offset: 50 }, signal)
  })

  it('aborts an old exact query key on page/source switch without giving the new key its data', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const aborted = vi.fn()
    const first = new QueryObserver(client, {
      queryKey: ['workspace', 'w', 'documents', 'list', null, 1, 25],
      queryFn: ({ signal }) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => {
        aborted()
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })),
    })
    const stop = first.subscribe(() => undefined)
    void first.refetch()
    await client.cancelQueries({ queryKey: ['workspace', 'w', 'documents', 'list', null, 1, 25], exact: true })
    const second = new QueryObserver(client, {
      queryKey: ['workspace', 'w', 'documents', 'list', 'source-a', 1, 25],
      queryFn: () => Promise.resolve({ documents: ['source-only'], total: 1, hasMore: false }),
    })
    const stopSecond = second.subscribe(() => undefined)
    await second.refetch()
    expect(aborted).toHaveBeenCalledOnce()
    expect(second.getCurrentResult().data).toMatchObject({ documents: ['source-only'] })
    stop()
    stopSecond()
  })

  it('distinguishes initial errors from background errors with retained same-key data', () => {
    expect(isInitialDocumentListLoading({ data: undefined, isPending: true })).toBe(true)
    expect(isInitialDocumentListLoading({ data: undefined, isPending: false })).toBe(false)
    expect(isInitialDocumentListLoading({
      data: { documents: [], total: 0, hasMore: false, nextCursor: null },
      isPending: true,
    })).toBe(false)
  })

  it('patches and removes only the exact current list cache row and total', () => {
    const client = new QueryClient()
    const key = ['workspace', 'w', 'documents', 'list', null, 1, 25]
    client.setQueryData(key, { documents: [
      { id: 'a', title: 'before' }, { id: 'b', title: 'other' },
    ], total: 2, hasMore: false, nextCursor: null })
    patchDocumentListRow(client, key, (row) => row.id === 'a' ? { ...row, title: 'after' } : row)
    removeDocumentListRow(client, key, 'a')
    expect(client.getQueryData(key)).toMatchObject({ documents: [{ id: 'b' }], total: 1 })
  })

  it('gates hidden reads, uses exact workspace/source keys, and retains an optimistic crawl cadence', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const list = vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue({ documents: [], total: 0, hasMore: false, nextCursor: null } as never)
    const source = vi.spyOn(documentsApi, 'listSourceDocuments').mockResolvedValue({
      documents: [{ id: 'processing-document', status: 'queued' }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    } as never)
    const crawls = vi.spyOn(documentsApi, 'listCrawlJobs').mockResolvedValue({ jobs: [] } as never)
    const root = await renderProbe(client, { enabled: false, workspaceId: 'workspace-a', sourceId: null, optimistic: [] })
    await flush()
    expect(list).not.toHaveBeenCalled()
    await act(async () => {
      root.render(createElement(
        QueryClientProvider,
        { client },
        createElement(DocumentProbe, {
          enabled: true,
          workspaceId: 'workspace-a',
          sourceId: 'source-a',
          optimistic: [{ id: 'optimistic', status: 'queued' }],
        }),
      ))
      await flush()
    })
    expect(source).toHaveBeenCalledWith('source-a', { limit: 25, offset: 0 }, expect.any(AbortSignal))
    const documents = client.getQueryCache().find({
      queryKey: ['workspace', 'workspace-a', 'documents', 'list', 'source-a', 1, 25],
      exact: true,
    })
    const documentInterval = (documents?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval
    expect(typeof documentInterval === 'function' && (documentInterval as (query: typeof documents) => number)(documents)).toBe(2_000)
    const crawl = client.getQueryCache().find({ queryKey: ['workspace', 'workspace-a', 'documents', 'crawl-activity', 30], exact: true })
    const interval = (crawl?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval
    expect(typeof interval === 'function' && (interval as (query: typeof crawl) => number)(crawl)).toBe(2_000)
    expect(crawls).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
  })
})
