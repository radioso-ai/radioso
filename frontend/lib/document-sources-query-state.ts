import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { WorkspaceInvalidationKind } from '@radioso/workspace-invalidation-contract'

import type { DocumentSourceListResponse, WebsiteCrawlJobSummary } from './api'
import { documentsApi } from './api'
import { dashboardQueryKeys } from './dashboard-query-keys'

export const SOURCE_CRAWL_RECENT_SINCE_MINUTES = 60
export const SOURCE_PROCESSING_STALE_MS = 10 * 60 * 1000

export const sourceMutationInvalidationKinds = {
  delete: ['document.status_changed', 'crawl.status_changed'],
  pause: ['crawl.status_changed'],
  recrawl: ['crawl.status_changed'],
  reprocess: ['document.status_changed'],
  resume: ['crawl.status_changed'],
} as const satisfies Record<string, readonly WorkspaceInvalidationKind[]>

export const shouldOverlayPausedSource = (pausedJobCount: number) => pausedJobCount > 0

export type SourceCrawlSnapshot = { jobs: WebsiteCrawlJobSummary[]; requestStartedAtMs: number }
export type SourceCrawlAction = 'pause' | 'recrawl' | 'resume'
export type SourceCrawlOverlayEntry = {
  action: SourceCrawlAction
  completedAtMs: number
  /** The recrawl endpoint creates a fresh job, so it gives us an exact acknowledgement identity. */
  jobId?: string
}
export type SourceCrawlOverlay = { entries: ReadonlyMap<string, SourceCrawlOverlayEntry> }

export const emptySourceCrawlOverlay = (): SourceCrawlOverlay => ({
  entries: new Map(),
})

/** A stale workspace's optimistic state must never be painted under the next workspace. */
export const effectiveSourceCrawlOverlay = (
  presentationWorkspaceId: string,
  workspaceId: string,
  overlay: SourceCrawlOverlay,
) => presentationWorkspaceId === workspaceId ? overlay : emptySourceCrawlOverlay()

export const fetchSourceCrawlSnapshot = async (signal: AbortSignal, now = Date.now()): Promise<SourceCrawlSnapshot> => {
  const requestStartedAtMs = now
  const [recent, paused] = await Promise.all([
    documentsApi.listCrawlJobs({ sinceMinutes: SOURCE_CRAWL_RECENT_SINCE_MINUTES }, signal),
    documentsApi.listCrawlJobs({ status: 'paused' }, signal),
  ])
  return {
    requestStartedAtMs,
    jobs: [...new Map([...recent.jobs, ...paused.jobs].map((job) => [job.id, job])).values()],
  }
}

export const deriveSourceCrawlState = (
  snapshot: SourceCrawlSnapshot | undefined,
  overlay: SourceCrawlOverlay,
  now = Date.now(),
) => {
  const active = new Set<string>()
  const paused = new Set<string>()
  for (const job of snapshot?.jobs ?? []) {
    if (!job.sourceId) continue
    const updatedAtMs = Date.parse(job.updatedAt)
    const freshProcessing = job.status === 'processing'
      && Number.isFinite(updatedAtMs)
      && now - updatedAtMs < SOURCE_PROCESSING_STALE_MS
    if (job.status === 'queued' || freshProcessing) active.add(job.sourceId)
    else if (job.status === 'paused') paused.add(job.sourceId)
  }
  for (const sourceId of active) paused.delete(sourceId)
  for (const [sourceId, entry] of overlay.entries) {
    if (entry.action === 'pause') {
      active.delete(sourceId)
      paused.add(sourceId)
    } else {
      active.add(sourceId)
      paused.delete(sourceId)
    }
  }
  return { active, paused }
}

export const sourceCrawlInterval = (active: ReadonlySet<string>, floorMs: number) => active.size > 0 ? 5_000 : floorMs

/**
 * An action overlay is only reconciled by a crawl request that began after the
 * action completed. This prevents a request already in flight from erasing a
 * just-accepted recrawl, pause, or resume.
 */
export const reconcileSourceCrawlOverlay = (
  overlay: SourceCrawlOverlay,
  snapshot: SourceCrawlSnapshot | undefined,
  now = Date.now(),
): SourceCrawlOverlay => {
  if (!snapshot) return overlay

  const reflected = deriveSourceCrawlState(snapshot, emptySourceCrawlOverlay(), now)
  const entries = new Map(overlay.entries)
  for (const [sourceId, entry] of entries) {
    // Equality is still pre-action: a response can be captured exactly as an
    // action settles, before the server applies the transition.
    if (snapshot.requestStartedAtMs <= entry.completedAtMs) continue

    if (entry.action === 'recrawl') {
      if (snapshot.jobs.some((job) => job.id === entry.jobId)) entries.delete(sourceId)
      continue
    }

    if (entry.action === 'pause' && reflected.paused.has(sourceId)) {
      entries.delete(sourceId)
    }
    if (entry.action === 'resume' && !reflected.paused.has(sourceId)) {
      entries.delete(sourceId)
    }
  }
  return entries.size === overlay.entries.size
    && [...entries].every(([sourceId, entry]) => overlay.entries.get(sourceId) === entry)
    ? overlay
    : { entries }
}

export const withSourceCrawlOverlay = (
  overlay: SourceCrawlOverlay,
  input: { action: SourceCrawlAction; completedAtMs: number; jobId?: string; sourceId: string },
): SourceCrawlOverlay => {
  const entries = new Map(overlay.entries)
  entries.set(input.sourceId, {
    action: input.action,
    completedAtMs: input.completedAtMs,
    jobId: input.jobId,
  })
  return { entries }
}

export const withoutSourceCrawlOverlay = (
  overlay: SourceCrawlOverlay,
  sourceId: string,
): SourceCrawlOverlay => {
  if (!overlay.entries.has(sourceId)) return overlay
  const entries = new Map(overlay.entries)
  entries.delete(sourceId)
  return { entries }
}

export const sourceCrawlOverlaySourceIds = (
  overlay: SourceCrawlOverlay,
  action: SourceCrawlAction,
) => new Set([...overlay.entries].flatMap(([sourceId, entry]) => entry.action === action ? [sourceId] : []))

export const useDocumentSourcesListQuery = ({
  enabled,
  floorMs,
  workspaceId,
}: {
  enabled: boolean
  floorMs: number
  workspaceId: string
}) => {
  const queryKey = dashboardQueryKeys.sources.list(workspaceId)
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => documentsApi.listSources(signal),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: floorMs,
  })
  return { ...query, queryKey }
}

export const useDocumentSourcesCrawlQuery = ({
  enabled,
  floorMs,
  overlay,
  workspaceId,
}: {
  enabled: boolean
  floorMs: number
  overlay: SourceCrawlOverlay
  workspaceId: string
}) => {
  const queryKey = dashboardQueryKeys.sources.crawlState(workspaceId)
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchSourceCrawlSnapshot(signal),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: (query) => sourceCrawlInterval(
      deriveSourceCrawlState(
        query.state.data,
        reconcileSourceCrawlOverlay(overlay, query.state.data),
      ).active,
      floorMs,
    ),
  })
  return { ...query, queryKey }
}

export const removeSourceListRow = (client: QueryClient, key: readonly unknown[], sourceId: string) =>
  client.setQueryData<DocumentSourceListResponse>(key, (current) => current
    ? { ...current, sources: current.sources.filter((source) => source.id !== sourceId) }
    : current)

export const patchSourceListRow = (
  client: QueryClient,
  key: readonly unknown[],
  sourceId: string,
  patch: (source: DocumentSourceListResponse['sources'][number]) => DocumentSourceListResponse['sources'][number],
) => client.setQueryData<DocumentSourceListResponse>(key, (current) => current
  ? { ...current, sources: current.sources.map((source) => source.id === sourceId ? patch(source) : source) }
  : current)
