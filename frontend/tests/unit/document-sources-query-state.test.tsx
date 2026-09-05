// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentsApi } from '@/lib/api'
import {
  deriveSourceCrawlState,
  emptySourceCrawlOverlay,
  effectiveSourceCrawlOverlay,
  fetchSourceCrawlSnapshot,
  patchSourceListRow,
  reconcileSourceCrawlOverlay,
  removeSourceListRow,
  sourceCrawlInterval,
  sourceCrawlOverlaySourceIds,
  sourceMutationInvalidationKinds,
  shouldOverlayPausedSource,
  useDocumentSourcesCrawlQuery,
  useDocumentSourcesListQuery,
  withSourceCrawlOverlay,
} from '@/lib/document-sources-query-state'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.restoreAllMocks())

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function SourceProbe({ enabled, floorMs, overlay, workspaceId }: {
  enabled: boolean
  floorMs: number
  overlay: ReturnType<typeof emptySourceCrawlOverlay>
  workspaceId: string
}) {
  useDocumentSourcesListQuery({ enabled, floorMs, workspaceId })
  useDocumentSourcesCrawlQuery({ enabled, floorMs, overlay, workspaceId })
  return null
}

const renderProbe = async (client: QueryClient, props: Parameters<typeof SourceProbe>[0]) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(SourceProbe, props)))
    await flush()
  })
  return root
}

describe('document sources query state', () => {
  it('uses one signal, lets paused win duplicate job ids, and derives fresh active sources', async () => {
    const signal = new AbortController().signal
    const spy = vi.spyOn(documentsApi, 'listCrawlJobs').mockResolvedValueOnce({ jobs: [
      { id: 'same', sourceId: 'a', status: 'processing', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] } as never).mockResolvedValueOnce({ jobs: [
      { id: 'same', sourceId: 'a', status: 'paused', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] } as never)
    const snapshot = await fetchSourceCrawlSnapshot(signal, Date.parse('2026-01-01T00:05:00.000Z'))
    expect(spy).toHaveBeenNthCalledWith(1, { sinceMinutes: 60 }, signal)
    expect(spy).toHaveBeenNthCalledWith(2, { status: 'paused' }, signal)
    const state = deriveSourceCrawlState(snapshot, emptySourceCrawlOverlay(), Date.parse('2026-01-01T00:05:00.000Z'))
    expect(state.paused).toEqual(new Set(['a']))
    expect(state.active).toEqual(new Set())
    spy.mockRestore()
  })

  it('treats invalid/stale processing as inactive and overlays active over paused', () => {
    const snapshot = { requestStartedAtMs: 0, jobs: [
      { id: 'bad', sourceId: 'bad', status: 'processing', updatedAt: 'bad' },
      { id: 'old', sourceId: 'old', status: 'processing', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'pause', sourceId: 'pause', status: 'paused', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] } as never
    const state = deriveSourceCrawlState(snapshot, withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
      action: 'recrawl', sourceId: 'pause', jobId: 'new-job', completedAtMs: 1,
    }), Date.parse('2026-01-01T00:10:00.000Z'))
    expect(state.active).toEqual(new Set(['pause']))
    expect(state.paused).toEqual(new Set())
    expect(sourceCrawlInterval(state.active, 45_000)).toBe(5_000)
    expect(sourceCrawlInterval(state.paused, 45_000)).toBe(45_000)
  })

  it('gives active server jobs precedence, while a pause overlay deliberately removes active state', () => {
    const snapshot = { requestStartedAtMs: 0, jobs: [
      { id: 'active', sourceId: 'same', status: 'queued', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'paused', sourceId: 'same', status: 'paused', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] } as never
    expect(deriveSourceCrawlState(snapshot, emptySourceCrawlOverlay()).active).toEqual(new Set(['same']))
    const pause = withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
      action: 'pause', sourceId: 'same', completedAtMs: 1,
    })
    expect(deriveSourceCrawlState(snapshot, pause).paused).toEqual(new Set(['same']))
    expect(deriveSourceCrawlState(snapshot, pause).active).toEqual(new Set())
  })

  it('acknowledges a reflected recrawl persistently, without resurrecting it on a later empty snapshot', () => {
    const overlay = withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
      action: 'recrawl', sourceId: 'source-a', jobId: 'new-job', completedAtMs: 100,
    })
    expect(reconcileSourceCrawlOverlay(overlay, { jobs: [], requestStartedAtMs: 99 })).toBe(overlay)
    expect(reconcileSourceCrawlOverlay(overlay, { jobs: [], requestStartedAtMs: 100 })).toBe(overlay)
    expect(sourceCrawlOverlaySourceIds(reconcileSourceCrawlOverlay(overlay, { jobs: [], requestStartedAtMs: 101 }), 'recrawl'))
      .toEqual(new Set(['source-a']))
    const reflected = reconcileSourceCrawlOverlay(overlay, {
      requestStartedAtMs: 101,
      jobs: [{ id: 'new-job', sourceId: 'source-a', status: 'queued', updatedAt: '2026-01-01T00:00:00.000Z' }],
    } as never, Date.parse('2026-01-01T00:01:00.000Z'))
    expect(sourceCrawlOverlaySourceIds(reflected, 'recrawl')).toEqual(new Set())
    const laterEmpty = reconcileSourceCrawlOverlay(reflected, { jobs: [], requestStartedAtMs: 102 })
    expect(sourceCrawlOverlaySourceIds(laterEmpty, 'recrawl')).toEqual(new Set())
    expect(sourceCrawlInterval(deriveSourceCrawlState({ jobs: [], requestStartedAtMs: 102 }, laterEmpty).active, 45_000))
      .toBe(45_000)
  })

  it('does not let a historical terminal job acknowledge a fresh recrawl', () => {
    const recrawl = withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
      action: 'recrawl', sourceId: 'source-a', jobId: 'new-job', completedAtMs: 100,
    })
    const historical = { requestStartedAtMs: 101, jobs: [{
      id: 'old-job', sourceId: 'source-a', status: 'completed', updatedAt: new Date(99).toISOString(),
    }] } as never
    expect(sourceCrawlOverlaySourceIds(reconcileSourceCrawlOverlay(recrawl, historical), 'recrawl'))
      .toEqual(new Set(['source-a']))
  })

  it('clears resume overlays after any post-action non-paused snapshot and retains them while paused', () => {
    const resume = withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
      action: 'resume', sourceId: 'source-a', completedAtMs: 100,
    })
    const paused = reconcileSourceCrawlOverlay(resume, {
      requestStartedAtMs: 101,
      jobs: [{ id: 'paused', sourceId: 'source-a', status: 'paused', updatedAt: new Date(1).toISOString() }],
    } as never)
    expect(sourceCrawlOverlaySourceIds(paused, 'resume')).toEqual(new Set(['source-a']))

    for (const jobs of [
      [{ id: 'active', sourceId: 'source-a', status: 'queued', updatedAt: new Date(1).toISOString() }],
      [{ id: 'terminal', sourceId: 'source-a', status: 'completed', updatedAt: new Date(1).toISOString() }],
      [],
    ]) {
      const cleared = reconcileSourceCrawlOverlay(resume, { requestStartedAtMs: 101, jobs } as never)
      expect(sourceCrawlOverlaySourceIds(cleared, 'resume')).toEqual(new Set())
      expect(sourceCrawlOverlaySourceIds(reconcileSourceCrawlOverlay(cleared, {
        requestStartedAtMs: 102, jobs: [],
      }), 'resume')).toEqual(new Set())
    }

    const clearedEmpty = reconcileSourceCrawlOverlay(resume, { requestStartedAtMs: 101, jobs: [] })
    expect(sourceCrawlInterval(
      deriveSourceCrawlState({ requestStartedAtMs: 102, jobs: [] }, clearedEmpty).active,
      45_000,
    )).toBe(45_000)
  })

  it('does not carry an action overlay into another workspace', () => {
    const overlay = withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
      action: 'recrawl', sourceId: 'source-a', jobId: 'new-job', completedAtMs: 1,
    })
    expect(sourceCrawlOverlaySourceIds(effectiveSourceCrawlOverlay('workspace-a', 'workspace-b', overlay), 'recrawl')).toEqual(new Set())
    expect(effectiveSourceCrawlOverlay('workspace-a', 'workspace-a', overlay)).toBe(overlay)
  })

  it('uses exact workspace keys, stays hidden when disabled, and upgrades only active crawl state to 5s', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const list = vi.spyOn(documentsApi, 'listSources').mockResolvedValue({ sources: [] })
    const crawls = vi.spyOn(documentsApi, 'listCrawlJobs').mockResolvedValue({ jobs: [] })
    const root = await renderProbe(client, {
      enabled: false, floorMs: 45_000, workspaceId: 'workspace-a', overlay: emptySourceCrawlOverlay(),
    })
    expect(list).not.toHaveBeenCalled()
    expect(crawls).not.toHaveBeenCalled()

    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(SourceProbe, {
        enabled: true,
        floorMs: 45_000,
        workspaceId: 'workspace-a',
        overlay: withSourceCrawlOverlay(emptySourceCrawlOverlay(), {
          action: 'recrawl', sourceId: 'source-a', jobId: 'new-job', completedAtMs: Date.now() + 1,
        }),
      })))
      await flush()
    })
    expect(list).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(crawls).toHaveBeenNthCalledWith(1, { sinceMinutes: 60 }, expect.any(AbortSignal))
    expect(crawls).toHaveBeenNthCalledWith(2, { status: 'paused' }, expect.any(AbortSignal))
    const crawl = client.getQueryCache().find({
      queryKey: ['workspace', 'workspace-a', 'sources', 'crawl-state'], exact: true,
    })
    const interval = (crawl?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval
    expect(typeof interval === 'function' && crawl && (interval as (query: typeof crawl) => number)(crawl)).toBe(5_000)
    await act(async () => { root.unmount() })
  })

  it('keeps same-key cached sources on a background failure', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const list = vi.spyOn(documentsApi, 'listSources')
      .mockResolvedValueOnce({ sources: [{ id: 'a', name: 'cached' }] } as never)
      .mockRejectedValueOnce(new Error('temporary failure'))
    vi.spyOn(documentsApi, 'listCrawlJobs').mockResolvedValue({ jobs: [] })
    const root = await renderProbe(client, {
      enabled: true, floorMs: 45_000, workspaceId: 'workspace-a', overlay: emptySourceCrawlOverlay(),
    })
    await client.refetchQueries({ queryKey: ['workspace', 'workspace-a', 'sources', 'list'], exact: true })
    const query = client.getQueryCache().find({
      queryKey: ['workspace', 'workspace-a', 'sources', 'list'], exact: true,
    })
    expect(list).toHaveBeenCalledTimes(2)
    expect(query?.state.data).toMatchObject({ sources: [{ name: 'cached' }] })
    expect(query?.state.error).toBeInstanceOf(Error)
    await act(async () => { root.unmount() })
  })

  it('patches only the exact sources list cache row', () => {
    const client = new QueryClient()
    const key = ['workspace', 'workspace-a', 'sources', 'list']
    const other = ['workspace', 'workspace-b', 'sources', 'list']
    client.setQueryData(key, { sources: [{ id: 'a', name: 'before' }] })
    client.setQueryData(other, { sources: [{ id: 'a', name: 'other workspace' }] })
    patchSourceListRow(client, key, 'a', (source) => ({ ...source, name: 'after' }))
    removeSourceListRow(client, key, 'a')
    expect(client.getQueryData(key)).toMatchObject({ sources: [] })
    expect(client.getQueryData(other)).toMatchObject({ sources: [{ name: 'other workspace' }] })
  })

  it('maps successful source mutations to their exact semantic invalidations', () => {
    expect(sourceMutationInvalidationKinds.recrawl).toEqual(['crawl.status_changed'])
    expect(sourceMutationInvalidationKinds.pause).toEqual(['crawl.status_changed'])
    expect(sourceMutationInvalidationKinds.resume).toEqual(['crawl.status_changed'])
    expect(sourceMutationInvalidationKinds.reprocess).toEqual(['document.status_changed'])
    expect(sourceMutationInvalidationKinds.delete).toEqual(['document.status_changed', 'crawl.status_changed'])
    expect(shouldOverlayPausedSource(0)).toBe(false)
    expect(shouldOverlayPausedSource(1)).toBe(true)
  })
})
