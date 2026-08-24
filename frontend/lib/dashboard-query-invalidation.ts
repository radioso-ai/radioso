import type { WorkspaceInvalidationKind } from '@radioso/workspace-invalidation-contract'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import {
  historyVariantForKey,
  isDashboardQueryFamily,
  isDashboardQueryKey,
  type DashboardQueryKey,
} from './dashboard-query-keys'

type DashboardQuery = ReturnType<ReturnType<QueryClient['getQueryCache']>['getAll']>[number]

type QueryWork = {
  dirty: boolean
  invalidating: boolean
}

export type DashboardQueryInvalidation =
  | { type: 'invalidate'; kinds: readonly WorkspaceInvalidationKind[] }
  | { type: 'ready' }
  | { type: 'resync' }
  | { type: 'visibility'; visible: boolean }

const isActiveInWorkspace = (query: DashboardQuery, workspaceId: string) =>
  query.getObserversCount() > 0 && isDashboardQueryKey(query.queryKey, workspaceId)

const matchesHistory = (
  queryKey: DashboardQueryKey,
  workspaceId: string,
  variants: readonly ('all' | 'chat' | 'contact' | 'search')[],
) => {
  const variant = historyVariantForKey(queryKey, workspaceId)
  return variant !== null && variants.includes(variant)
}

/** Exact kind × active-query-variant ownership; broad prefix invalidation is prohibited. */
export const matchesWorkspaceInvalidation = (
  kind: WorkspaceInvalidationKind,
  queryKey: QueryKey,
  workspaceId: string,
) => {
  switch (kind) {
    case 'document.status_changed':
      return isDashboardQueryFamily(queryKey, workspaceId, 'documents/list')
    case 'crawl.status_changed':
      return isDashboardQueryFamily(queryKey, workspaceId, 'documents/crawl-activity')
        || isDashboardQueryFamily(queryKey, workspaceId, 'sources/crawl-state')
        || isDashboardQueryFamily(queryKey, workspaceId, 'sources/list')
    case 'crawl.progress':
      return isDashboardQueryFamily(queryKey, workspaceId, 'documents/crawl-activity')
    case 'hitl.decision_created':
    case 'hitl.decision_resolved':
      return isDashboardQueryFamily(queryKey, workspaceId, 'attention/decisions')
    case 'conversation.ownership_changed':
      return isDashboardQueryFamily(queryKey, workspaceId, 'attention/human-owned')
        || matchesHistory(queryKey, workspaceId, ['all', 'chat'])
    case 'conversation.created':
    case 'conversation.turn_committed':
      return matchesHistory(queryKey, workspaceId, ['all', 'chat'])
    case 'conversation.contact_delivery_changed':
      return matchesHistory(queryKey, workspaceId, ['all', 'contact'])
    case 'search.created':
      return matchesHistory(queryKey, workspaceId, ['all', 'search'])
    case 'quality.feedback_changed':
    case 'quality.triage_changed':
      return isDashboardQueryFamily(queryKey, workspaceId, 'quality/stats')
        || isDashboardQueryFamily(queryKey, workspaceId, 'quality/turns')
  }
}

/**
 * QueryCache remains the scheduler and registry. This object only tracks the
 * one dirty bit which lets a query finish its current request and then receive
 * one trailing reconciliation for a burst of invalidations.
 */
export class DashboardQueryInvalidationCoordinator {
  private readonly workByHash = new Map<string, QueryWork>()
  private cacheUnsubscribe: (() => void) | null = null
  private disposed = false
  private visible = true

  constructor(private readonly input: { queryClient: QueryClient; workspaceId: string }) {}

  subscribe(): () => void {
    if (!this.cacheUnsubscribe) {
      this.cacheUnsubscribe = this.input.queryClient.getQueryCache().subscribe(() => this.pruneInactiveWork())
    }
    return () => this.deactivate()
  }

  /** React StrictMode may deactivate and reactivate the same provider instance. */
  deactivate(): void {
    this.cacheUnsubscribe?.()
    this.cacheUnsubscribe = null
    this.workByHash.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.deactivate()
  }

  invalidate(kinds: readonly WorkspaceInvalidationKind[]): void {
    this.process({ type: 'invalidate', kinds })
  }

  reconcileAllActive(): void {
    this.process({ type: 'resync' })
  }

  setVisible(visible: boolean): void {
    this.process({ type: 'visibility', visible })
  }

  process(event: DashboardQueryInvalidation): void {
    if (this.disposed) return

    if (event.type === 'visibility') {
      this.visible = event.visible
      // Visibility only gates work. The provider reconnects live interest first
      // and then emits ready/resync, so reopening a tab cannot fetch ahead of
      // the subscription attempt.
      return
    }
    if (!this.visible) return

    const active = this.activeQueries()
    if (event.type === 'invalidate') {
      for (const query of active) {
        if (event.kinds.some((kind) => matchesWorkspaceInvalidation(kind, query.queryKey, this.input.workspaceId))) {
          this.requestReconciliation(query)
        }
      }
      return
    }

    for (const query of active) this.requestReconciliation(query)
  }

  /** Invoked from QueryCache notifications too, so an in-flight pre-existing fetch can settle. */
  reconcileSettledQueries(): void {
    if (this.disposed || !this.visible) return
    for (const query of this.activeQueries()) {
      const work = this.workByHash.get(query.queryHash)
      if (work?.dirty && !work.invalidating && query.state.fetchStatus === 'idle') {
        this.requestReconciliation(query)
      }
    }
  }

  private activeQueries(): DashboardQuery[] {
    return this.input.queryClient.getQueryCache().getAll()
      .filter((query) => isActiveInWorkspace(query, this.input.workspaceId))
  }

  private requestReconciliation(query: DashboardQuery): void {
    if (!this.visible || this.disposed || !isActiveInWorkspace(query, this.input.workspaceId)) return

    const work = this.workByHash.get(query.queryHash) ?? { dirty: false, invalidating: false }
    this.workByHash.set(query.queryHash, work)

    if (work.invalidating || query.state.fetchStatus === 'fetching') {
      work.dirty = true
      return
    }

    work.invalidating = true
    work.dirty = false
    void this.input.queryClient
      .invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'active' })
      .catch(() => undefined)
      .finally(() => this.finishReconciliation(query, work))
  }

  private finishReconciliation(query: DashboardQuery, work: QueryWork): void {
    if (this.disposed || this.workByHash.get(query.queryHash) !== work) return
    work.invalidating = false

    if (this.visible && work.dirty && isActiveInWorkspace(query, this.input.workspaceId)) {
      this.requestReconciliation(query)
      return
    }

    if (!work.dirty) this.workByHash.delete(query.queryHash)
  }

  private pruneInactiveWork(): void {
    if (this.disposed) return
    this.reconcileSettledQueries()
    const activeHashes = new Set(this.activeQueries().map((query) => query.queryHash))
    for (const hash of this.workByHash.keys()) {
      if (!activeHashes.has(hash)) this.workByHash.delete(hash)
    }
  }
}
