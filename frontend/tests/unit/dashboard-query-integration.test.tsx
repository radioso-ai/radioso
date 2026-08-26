// @vitest-environment jsdom

import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useHistoryListQuery } from '@/components/dashboard/history/history-list-query'
import { DashboardQueryProvider, useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { documentsApi } from '@/lib/api'
import { chatApi } from '@/lib/api-chat'
import { hitlApi } from '@/lib/api-hitl'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { useDocumentCrawlActivityQuery, useDocumentListQuery } from '@/lib/documents-query-state'
import { emptySourceCrawlOverlay, useDocumentSourcesCrawlQuery, useDocumentSourcesListQuery } from '@/lib/document-sources-query-state'
import { NEEDS_ATTENTION_PAGE_SIZE, needsAttentionQualityInputs, useNeedsAttentionQueries } from '@/lib/needs-attention-query-state'
import { qualityApi } from '@/lib/api-quality'
import { useQualityStatsQuery, useQualityTurnsQuery } from '@/lib/quality-query-state'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pageSize = 25
const regularQualityInput = { page: 1, pageSize }
const qualityStatsInput = { range: '7d' as const }

const familyKeys = (workspaceId: string) => ({
  attentionCommented: dashboardQueryKeys.quality.turns(workspaceId, needsAttentionQualityInputs.commentedFeedback),
  attentionDecisions: dashboardQueryKeys.attention.decisions(workspaceId),
  attentionHumanOwned: dashboardQueryKeys.attention.humanOwned(workspaceId, { pageSize: NEEDS_ATTENTION_PAGE_SIZE }),
  attentionReview: dashboardQueryKeys.quality.turns(workspaceId, needsAttentionQualityInputs.reviewSummary),
  documentsCrawl: dashboardQueryKeys.documents.crawlActivity(workspaceId, { recentSinceMinutes: 30 }),
  documentsList: dashboardQueryKeys.documents.list(workspaceId, { page: 1, pageSize, sourceId: null }),
  historyAll: dashboardQueryKeys.history.list(workspaceId, { page: 1, pageSize, variant: 'all' }),
  qualityStats: dashboardQueryKeys.quality.stats(workspaceId, qualityStatsInput),
  qualityTurns: dashboardQueryKeys.quality.turns(workspaceId, regularQualityInput),
  sourcesCrawl: dashboardQueryKeys.sources.crawlState(workspaceId),
  sourcesList: dashboardQueryKeys.sources.list(workspaceId),
})

type AdapterName = 'crawlJobs' | 'decisions' | 'documents' | 'history' | 'humanOwned' | 'qualityStats' | 'qualityTurns' | 'sources'
type SignalLog = Map<AdapterName, AbortSignal[]>

const signalLog = (): SignalLog => new Map()

const record = (log: SignalLog, name: AdapterName, signal: AbortSignal | undefined) => {
  if (!signal) return
  const signals = log.get(name) ?? []
  signals.push(signal)
  log.set(name, signals)
}

const recordPending = <T,>(log: SignalLog, name: AdapterName, signal: AbortSignal) => new Promise<T>((resolve) => {
  record(log, name, signal)
  signal.addEventListener('abort', () => resolve({} as T), { once: true })
})

const installsRevisionAdapters = (readRevision: () => string, log = signalLog()) => {
  vi.spyOn(documentsApi, 'listDocuments').mockImplementation((_input, signal) => {
    record(log, 'documents', signal)
    return Promise.resolve({ documents: [{ id: `document-${readRevision()}` }], hasMore: false, total: 1 } as never)
  })
  vi.spyOn(documentsApi, 'listCrawlJobs').mockImplementation((_input, signal) => {
    record(log, 'crawlJobs', signal)
    return Promise.resolve({ jobs: [{ id: `crawl-${readRevision()}`, status: 'completed' }] } as never)
  })
  vi.spyOn(documentsApi, 'listSources').mockImplementation((signal) => {
    record(log, 'sources', signal)
    return Promise.resolve({ sources: [{ id: `source-${readRevision()}` }] } as never)
  })
  vi.spyOn(chatApi, 'listHistory').mockImplementation((_input, signal) => {
    record(log, 'history', signal)
    return Promise.resolve({ revision: readRevision() } as never)
  })
  vi.spyOn(chatApi, 'listChatHistory').mockImplementation((input, signal) => {
    const name: AdapterName = input?.ownership === 'human_owned' ? 'humanOwned' : 'history'
    record(log, name, signal)
    return Promise.resolve({ conversations: [{ id: `${name}-${readRevision()}` }], revision: readRevision(), total: 1 } as never)
  })
  vi.spyOn(hitlApi, 'listPendingDecisions').mockImplementation((signal) => {
    record(log, 'decisions', signal)
    return Promise.resolve({ decisions: [], revision: readRevision() } as never)
  })
  vi.spyOn(qualityApi, 'getStats').mockImplementation((_input, signal) => {
    record(log, 'qualityStats', signal)
    return Promise.resolve({ range: '7d', revision: readRevision() } as never)
  })
  vi.spyOn(qualityApi, 'listTurns').mockImplementation((_input, signal) => {
    record(log, 'qualityTurns', signal)
    return Promise.resolve({ items: [], page: 1, pageSize, revision: readRevision(), total: 0, totalPages: 0 } as never)
  })
  return log
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

function Families({
  historyVariant = 'all',
  onClient,
  page = 1,
  workspaceId,
}: {
  historyVariant?: 'all' | 'chat'
  onClient?: (workspaceId: string, client: QueryClient) => void
  page?: number
  workspaceId: string
}) {
  const policy = useDashboardQueryPolicy()
  const client = useQueryClient()
  const keys = familyKeys(workspaceId)

  useEffect(() => {
    onClient?.(workspaceId, client)
  }, [client, onClient, workspaceId])

  useDocumentListQuery({ enabled: policy.queriesEnabled, intervalMs: policy.intervalFor(keys.documentsList), page, pageSize, sourceId: null, workspaceId })
  useDocumentCrawlActivityQuery({ enabled: policy.queriesEnabled, floorMs: policy.intervalFor(keys.documentsCrawl), optimisticJobs: [], workspaceId })
  useDocumentSourcesListQuery({ enabled: policy.queriesEnabled, floorMs: policy.intervalFor(keys.sourcesList), workspaceId })
  useDocumentSourcesCrawlQuery({ enabled: policy.queriesEnabled, floorMs: policy.intervalFor(keys.sourcesCrawl), overlay: emptySourceCrawlOverlay(), workspaceId })
  useHistoryListQuery({ page, pageSize, variant: historyVariant, workspaceId })
  useQualityStatsQuery(workspaceId, qualityStatsInput, policy.queriesEnabled, policy.intervalFor(keys.qualityStats))
  useQualityTurnsQuery(workspaceId, regularQualityInput, policy.queriesEnabled, policy.intervalFor(keys.qualityTurns))
  useNeedsAttentionQueries(workspaceId)
  return null
}

const setVisibility = (value: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
  document.dispatchEvent(new Event('visibilitychange'))
}

const revisionIn = (data: unknown, revision: string) => JSON.stringify(data).includes(revision)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

describe('dashboard query integration', () => {
  it('aborts a same-workspace all/page query and fences its late response from chat/page', async () => {
    const all = Promise.withResolvers<unknown>()
    const signals = installsRevisionAdapters(() => 'current')
    vi.mocked(chatApi.listHistory).mockImplementation((_input, signal) => {
      record(signals, 'history', signal)
      return all.promise as never
    })
    vi.mocked(chatApi.listChatHistory).mockImplementation((input) => input?.ownership === 'human_owned'
      ? Promise.resolve({ conversations: [], total: 0 } as never)
      : Promise.resolve({ conversations: [], revision: 'chat-2', total: 0 } as never))
    const clients = new Map<string, QueryClient>()
    const root = createRoot(document.createElement('div'))
    const onClient = (workspaceId: string, client: QueryClient) => clients.set(workspaceId, client)

    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" onClient={onClient} /></DashboardQueryProvider>) })
    await settle()
    const oldSignal = signals.get('history')?.[0]
    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" historyVariant="chat" page={2} onClient={onClient} /></DashboardQueryProvider>) })
    await settle()
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { all.resolve({ revision: 'late-all' }); await Promise.resolve() })

    const client = clients.get('workspace-a')
    expect(client?.getQueryData(dashboardQueryKeys.history.list('workspace-a', { page: 1, pageSize, variant: 'all' }))).toBeUndefined()
    expect(client?.getQueryData(dashboardQueryKeys.history.list('workspace-a', { page: 2, pageSize, variant: 'chat' }))).toEqual({ response: { conversations: [], revision: 'chat-2', total: 0 }, variant: 'chat' })
    await act(async () => root.unmount())
  })

  it('replaces and clears the A client, then fences late A data from B exact cache', async () => {
    const lateA = Promise.withResolvers<unknown>()
    const signals = installsRevisionAdapters(() => 'b')
    let documentCalls = 0
    vi.mocked(documentsApi.listDocuments).mockImplementation((_input, signal) => {
      documentCalls += 1
      record(signals, 'documents', signal)
      return documentCalls === 1
        ? lateA.promise as never
        : Promise.resolve({ documents: [{ id: 'document-b' }], hasMore: false, total: 1 } as never)
    })
    const clients = new Map<string, QueryClient>()
    const root = createRoot(document.createElement('div'))
    const onClient = (workspaceId: string, client: QueryClient) => clients.set(workspaceId, client)

    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" onClient={onClient} /></DashboardQueryProvider>) })
    await settle()
    const aClient = clients.get('workspace-a')
    expect(aClient?.getQueryCache().find({ exact: true, queryKey: familyKeys('workspace-a').documentsList })).toBeDefined()
    const aSignal = signals.get('documents')?.[0]
    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-b"><Families workspaceId="workspace-b" onClient={onClient} /></DashboardQueryProvider>) })
    await settle()
    await act(async () => { lateA.resolve({ documents: [{ id: 'late-a' }], hasMore: false, total: 1 }); await Promise.resolve() })

    const bClient = clients.get('workspace-b')
    expect(bClient).not.toBe(aClient)
    expect(aClient?.getQueryCache().getAll()).toEqual([])
    expect(aSignal?.aborted).toBe(true)
    expect(bClient?.getQueryData(familyKeys('workspace-a').documentsList)).toBeUndefined()
    expect(bClient?.getQueryData(familyKeys('workspace-b').documentsList)).toEqual({ documents: [{ id: 'document-b' }], hasMore: false, total: 1 })
    await act(async () => root.unmount())
  })

  it('keeps exactly one active visibility listener through StrictMode and removes it on final unmount', async () => {
    const addEventListener = document.addEventListener.bind(document)
    const removeEventListener = document.removeEventListener.bind(document)
    const active = new Set<EventListenerOrEventListenerObject>()
    let maximum = 0
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'visibilitychange') {
        active.add(listener)
        maximum = Math.max(maximum, active.size)
      }
      addEventListener(type, listener, options)
    })
    vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (type === 'visibilitychange') active.delete(listener)
      removeEventListener(type, listener, options)
    })
    installsRevisionAdapters(() => 'listener')
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(<StrictMode><DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" /></DashboardQueryProvider></StrictMode>) })
    await settle()
    expect(maximum).toBe(1)
    expect(active).toHaveLength(1)
    await act(async () => root.unmount())
    expect(active).toHaveLength(0)
  })

  it('aborts each adapter family while hidden and makes no hidden reads for a minute', async () => {
    vi.useFakeTimers()
    const signals = signalLog()
    vi.spyOn(documentsApi, 'listDocuments').mockImplementation((_input, signal) => recordPending(signals, 'documents', signal!) as never)
    vi.spyOn(documentsApi, 'listCrawlJobs').mockImplementation((_input, signal) => recordPending(signals, 'crawlJobs', signal!) as never)
    vi.spyOn(documentsApi, 'listSources').mockImplementation((signal) => recordPending(signals, 'sources', signal!) as never)
    vi.spyOn(chatApi, 'listHistory').mockImplementation((_input, signal) => recordPending(signals, 'history', signal!) as never)
    vi.spyOn(chatApi, 'listChatHistory').mockImplementation((input, signal) => recordPending(signals, input?.ownership === 'human_owned' ? 'humanOwned' : 'history', signal!) as never)
    vi.spyOn(hitlApi, 'listPendingDecisions').mockImplementation((signal) => recordPending(signals, 'decisions', signal!) as never)
    vi.spyOn(qualityApi, 'getStats').mockImplementation((_input, signal) => recordPending(signals, 'qualityStats', signal!) as never)
    vi.spyOn(qualityApi, 'listTurns').mockImplementation((_input, signal) => recordPending(signals, 'qualityTurns', signal!) as never)
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" /></DashboardQueryProvider>); await vi.advanceTimersByTimeAsync(1) })
    const counts = new Map([...signals].map(([name, values]) => [name, values.length]))
    expect([...counts.keys()].sort()).toEqual(['crawlJobs', 'decisions', 'documents', 'history', 'humanOwned', 'qualityStats', 'qualityTurns', 'sources'])
    await act(async () => { setVisibility('hidden'); await vi.advanceTimersByTimeAsync(60_000) })
    for (const [name, values] of signals) {
      expect(values.every((signal) => signal.aborted), name).toBe(true)
      expect(values).toHaveLength(counts.get(name) ?? 0)
    }
    await act(async () => root.unmount())
  })

  it('enables poll-only queries after show and stores a fresh revision at every exact key', async () => {
    setVisibility('hidden')
    let revision = 'hidden'
    installsRevisionAdapters(() => revision)
    const clients = new Map<string, QueryClient>()
    const root = createRoot(document.createElement('div'))
    const onClient = (workspaceId: string, client: QueryClient) => clients.set(workspaceId, client)
    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" onClient={onClient} /></DashboardQueryProvider>) })
    await settle()
    expect(documentsApi.listDocuments).not.toHaveBeenCalled()
    expect(hitlApi.listPendingDecisions).not.toHaveBeenCalled()
    revision = 'shown'
    await act(async () => { setVisibility('visible') })
    await settle()
    const client = clients.get('workspace-a')
    for (const key of Object.values(familyKeys('workspace-a'))) {
      expect(revisionIn(client?.getQueryState(key)?.data, 'shown')).toBe(true)
    }
    await act(async () => root.unmount())
  })

  it('reconciles every visible family by its deterministic <=60s floor without realtime', async () => {
    vi.useFakeTimers()
    let revision = 'one'
    installsRevisionAdapters(() => revision)
    const clients = new Map<string, QueryClient>()
    const root = createRoot(document.createElement('div'))
    const onClient = (workspaceId: string, client: QueryClient) => clients.set(workspaceId, client)
    await act(async () => { root.render(<DashboardQueryProvider workspaceId="workspace-a"><Families workspaceId="workspace-a" onClient={onClient} /></DashboardQueryProvider>); await vi.advanceTimersByTimeAsync(1) })
    revision = 'two'
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    const client = clients.get('workspace-a')
    for (const key of Object.values(familyKeys('workspace-a'))) {
      expect(revisionIn(client?.getQueryState(key)?.data, 'two')).toBe(true)
    }
    await act(async () => root.unmount())
  })
})
