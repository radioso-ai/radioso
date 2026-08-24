import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { INVALIDATION_KINDS } from '@radioso/workspace-invalidation-contract'

import {
  DashboardQueryInvalidationCoordinator,
  matchesWorkspaceInvalidation,
} from '@/lib/dashboard-query-invalidation'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'

const workspaceId = 'workspace-a'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

const createClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

describe('dashboard query invalidation coordinator', () => {
  it('maps each invalidation kind to its exact active history variants', () => {
    const variants = {
      all: dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50 }),
      chat: dashboardQueryKeys.history.list(workspaceId, { variant: 'chat', page: 1, pageSize: 50 }),
      contact: dashboardQueryKeys.history.list(workspaceId, { variant: 'contact', page: 1, pageSize: 50 }),
      search: dashboardQueryKeys.history.list(workspaceId, { variant: 'search', page: 1, pageSize: 50 }),
    }

    expect(Object.fromEntries(Object.entries(variants).map(([variant, key]) => [variant,
      matchesWorkspaceInvalidation('conversation.ownership_changed', key, workspaceId),
    ]))).toEqual({ all: true, chat: true, contact: false, search: false })
    expect(Object.fromEntries(Object.entries(variants).map(([variant, key]) => [variant,
      matchesWorkspaceInvalidation('conversation.contact_delivery_changed', key, workspaceId),
    ]))).toEqual({ all: true, chat: false, contact: true, search: false })
    expect(Object.fromEntries(Object.entries(variants).map(([variant, key]) => [variant,
      matchesWorkspaceInvalidation('search.created', key, workspaceId),
    ]))).toEqual({ all: true, chat: false, contact: false, search: true })
    expect(matchesWorkspaceInvalidation(
      'conversation.ownership_changed',
      dashboardQueryKeys.attention.humanOwned(workspaceId, { pageSize: 25 }),
      workspaceId,
    )).toBe(true)
  })

  it('rejects unrelated workspaces and non-owning query families', () => {
    const key = dashboardQueryKeys.history.list('workspace-b', { variant: 'all', page: 1, pageSize: 50 })
    expect(matchesWorkspaceInvalidation('conversation.created', key, workspaceId)).toBe(false)
    expect(matchesWorkspaceInvalidation(
      'search.created',
      dashboardQueryKeys.quality.stats(workspaceId, { range: '7d' }),
      workspaceId,
    )).toBe(false)
  })

  it('covers the remaining contract kinds without broadening into unrelated dashboard families', () => {
    const turns = dashboardQueryKeys.quality.turns(workspaceId, {
      activeNegativeFeedbackOnly: false,
      hasComment: false,
      hasInvalidSources: false,
      hasUnsourcedClaims: false,
      page: 1,
      pageSize: 25,
      sort: 'turn_created_at',
    })
    const cases = [
      ['document.status_changed', dashboardQueryKeys.documents.list(workspaceId, { sourceId: null, page: 1, pageSize: 25 })],
      ['crawl.status_changed', dashboardQueryKeys.documents.crawlActivity(workspaceId, { recentSinceMinutes: 60 })],
      ['crawl.progress', dashboardQueryKeys.documents.crawlActivity(workspaceId, { recentSinceMinutes: 60 })],
      ['hitl.decision_created', dashboardQueryKeys.attention.decisions(workspaceId)],
      ['hitl.decision_resolved', dashboardQueryKeys.attention.decisions(workspaceId)],
      ['quality.feedback_changed', dashboardQueryKeys.quality.stats(workspaceId, { range: '7d' })],
      ['quality.triage_changed', turns],
    ] as const

    for (const [kind, ownedKey] of cases) {
      expect(matchesWorkspaceInvalidation(kind, ownedKey, workspaceId)).toBe(true)
      expect(matchesWorkspaceInvalidation(kind, dashboardQueryKeys.sources.list(workspaceId), workspaceId))
        .toBe(kind === 'crawl.status_changed')
    }
  })

  it('exhaustively enforces the 12-kind matrix across every dashboard family and history variant', () => {
    const familyKeys = {
      documentList: dashboardQueryKeys.documents.list(workspaceId, { sourceId: null, page: 1, pageSize: 25 }),
      crawlActivity: dashboardQueryKeys.documents.crawlActivity(workspaceId, { recentSinceMinutes: 60 }),
      sources: dashboardQueryKeys.sources.list(workspaceId),
      sourceCrawlState: dashboardQueryKeys.sources.crawlState(workspaceId),
      historyAll: dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50 }),
      historyChat: dashboardQueryKeys.history.list(workspaceId, { variant: 'chat', page: 1, pageSize: 50 }),
      historyContact: dashboardQueryKeys.history.list(workspaceId, { variant: 'contact', page: 1, pageSize: 50 }),
      historySearch: dashboardQueryKeys.history.list(workspaceId, { variant: 'search', page: 1, pageSize: 50 }),
      qualityStats: dashboardQueryKeys.quality.stats(workspaceId, {}),
      qualityTurns: dashboardQueryKeys.quality.turns(workspaceId, { page: 1, pageSize: 25 }),
      decisions: dashboardQueryKeys.attention.decisions(workspaceId),
      humanOwned: dashboardQueryKeys.attention.humanOwned(workspaceId, { pageSize: 25 }),
    }
    const expected: Record<(typeof INVALIDATION_KINDS)[number], readonly (keyof typeof familyKeys)[]> = {
      'document.status_changed': ['documentList'],
      'crawl.status_changed': ['crawlActivity', 'sources', 'sourceCrawlState'],
      'crawl.progress': ['crawlActivity'],
      'conversation.created': ['historyAll', 'historyChat'],
      'conversation.turn_committed': ['historyAll', 'historyChat'],
      'conversation.contact_delivery_changed': ['historyAll', 'historyContact'],
      'conversation.ownership_changed': ['historyAll', 'historyChat', 'humanOwned'],
      'search.created': ['historyAll', 'historySearch'],
      'hitl.decision_created': ['decisions'],
      'hitl.decision_resolved': ['decisions'],
      'quality.feedback_changed': ['qualityStats', 'qualityTurns'],
      'quality.triage_changed': ['qualityStats', 'qualityTurns'],
    }

    for (const kind of INVALIDATION_KINDS) {
      for (const [family, queryKey] of Object.entries(familyKeys)) {
        expect(matchesWorkspaceInvalidation(kind, queryKey, workspaceId)).toBe(expected[kind].includes(family as keyof typeof familyKeys))
      }
    }
  })

  it('preserves an in-flight request and runs exactly one trailing reconciliation for a burst', async () => {
    const client = createClient()
    const key = dashboardQueryKeys.documents.list(workspaceId, { sourceId: null, page: 1, pageSize: 25 })
    const second = deferred<number>()
    const third = deferred<number>()
    let calls = 0
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => {
        calls += 1
        if (calls === 2) return second.promise
        if (calls === 3) return third.promise
        return Promise.resolve(calls)
      },
    })
    const unobserve = observer.subscribe(() => undefined)
    await observer.refetch()

    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId })
    const stop = coordinator.subscribe()
    coordinator.invalidate(['document.status_changed'])
    await vi.waitFor(() => expect(calls).toBe(2))
    coordinator.invalidate(Array.from({ length: 20 }, () => 'document.status_changed' as const))
    second.resolve(2)
    await vi.waitFor(() => expect(calls).toBe(3))
    third.resolve(3)
    await flush()

    expect(calls).toBe(3)
    stop()
    unobserve()
  })

  it('marks a pre-existing fetch dirty for ready/resync and runs one trailing fetch while observed', async () => {
    const client = createClient()
    const key = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50 })
    const first = deferred<number>()
    let calls = 0
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve(calls)
      },
    })
    const unobserve = observer.subscribe(() => undefined)
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId })
    const stop = coordinator.subscribe()

    void observer.refetch()
    await vi.waitFor(() => expect(calls).toBe(1))
    coordinator.process({ type: 'ready' })
    coordinator.process({ type: 'resync' })
    first.resolve(1)
    await vi.waitFor(() => expect(calls).toBe(2))
    await flush()
    expect(calls).toBe(2)
    stop()
    unobserve()
  })

  it('prunes pending dirty work when an observer and its query are removed', async () => {
    const client = createClient()
    const key = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50 })
    const first = deferred<number>()
    let calls = 0
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve(calls)
      },
    })
    const unobserve = observer.subscribe(() => undefined)
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId })
    const stop = coordinator.subscribe()

    void observer.refetch()
    await vi.waitFor(() => expect(calls).toBe(1))
    coordinator.process({ type: 'ready' })
    unobserve()
    client.removeQueries({ queryKey: key, exact: true })
    first.resolve(1)
    await flush()

    expect(calls).toBe(1)
    stop()
  })

  it('pauses invalidation while hidden and reconciles active observers when visible again', async () => {
    const client = createClient()
    const key = dashboardQueryKeys.sources.list(workspaceId)
    const queryFn = vi.fn(() => Promise.resolve('sources'))
    const observer = new QueryObserver(client, { queryKey: key, queryFn })
    const unobserve = observer.subscribe(() => undefined)
    await observer.refetch()
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId })
    const stop = coordinator.subscribe()

    coordinator.setVisible(false)
    coordinator.invalidate(['crawl.status_changed'])
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)

    coordinator.setVisible(true)
    coordinator.process({ type: 'resync' })
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
    stop()
    unobserve()
  })

  it('reconciles only active matching queries and leaves inactive cached siblings untouched', async () => {
    const client = createClient()
    const inactiveKey = dashboardQueryKeys.documents.list(workspaceId, { sourceId: null, page: 1, pageSize: 25 })
    const activeKey = dashboardQueryKeys.documents.list(workspaceId, { sourceId: null, page: 2, pageSize: 25 })
    client.setQueryData(inactiveKey, 'cached-page-one')
    const queryFn = vi.fn(() => Promise.resolve('active-page-two'))
    const observer = new QueryObserver(client, { queryKey: activeKey, queryFn })
    const unobserve = observer.subscribe(() => undefined)
    await observer.refetch()
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId })
    const stop = coordinator.subscribe()

    coordinator.invalidate(['document.status_changed'])
    coordinator.process({ type: 'ready' })
    coordinator.process({ type: 'resync' })
    await vi.waitFor(() => expect(queryFn.mock.calls.length).toBeGreaterThan(1))

    const inactive = client.getQueryCache().find({ queryKey: inactiveKey, exact: true })
    expect(inactive?.state.data).toBe('cached-page-one')
    expect(inactive?.state.fetchStatus).toBe('idle')
    expect(inactive?.state.isInvalidated).toBe(false)
    stop()
    unobserve()
  })

  it('keeps dirty work paused through hide-and-cancel until the next visible resync', async () => {
    const client = createClient()
    const key = dashboardQueryKeys.documents.list(workspaceId, { sourceId: null, page: 1, pageSize: 25 })
    const first = deferred<number>()
    let calls = 0
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve(calls)
      },
    })
    const unobserve = observer.subscribe(() => undefined)
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId })
    const stop = coordinator.subscribe()

    void observer.refetch()
    await vi.waitFor(() => expect(calls).toBe(1))
    coordinator.invalidate(['document.status_changed'])
    coordinator.setVisible(false)
    await client.cancelQueries({ queryKey: key, exact: true })
    await flush()
    expect(calls).toBe(1)

    coordinator.setVisible(true)
    coordinator.process({ type: 'resync' })
    await vi.waitFor(() => expect(calls).toBe(2))
    stop()
    unobserve()
  })
})
