import type { WebsiteCrawlJobStatus, WebsiteCrawlJobSummary } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

export type ParsedCrawlForm =
  | {
      ok: true
      url: string
      limit?: number
      includeUrlPatterns: string[]
      excludeUrlPatterns: string[]
      preserveContentLinks: boolean
    }
  | { ok: false; error: string }

export function parseCrawlForm({
  url,
  limit,
  includeUrlPatterns = '',
  excludeUrlPatterns = '',
  preserveContentLinks = true,
  maxLimit,
}: {
  url: string
  limit: string
  includeUrlPatterns?: string
  excludeUrlPatterns?: string
  preserveContentLinks?: boolean
  maxLimit: number
}): ParsedCrawlForm {
  const trimmedUrl = url.trim()
  if (!trimmedUrl) {
    return { ok: false, error: 'Enter a website URL to crawl.' }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedUrl)
  } catch {
    return { ok: false, error: 'Enter a valid URL.' }
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http or https.' }
  }

  const trimmedLimit = limit.trim()
  if (!trimmedLimit) {
    return {
      ok: true,
      url: trimmedUrl,
      includeUrlPatterns: parsePatternLines(includeUrlPatterns),
      excludeUrlPatterns: parsePatternLines(excludeUrlPatterns),
      preserveContentLinks,
    }
  }

  const value = Number.parseInt(trimmedLimit, 10)
  if (!Number.isFinite(value) || value < 1 || String(value) !== trimmedLimit) {
    return { ok: false, error: 'Page limit must be a positive whole number.' }
  }

  return {
    ok: true,
    url: trimmedUrl,
    limit: Math.min(value, maxLimit),
    includeUrlPatterns: parsePatternLines(includeUrlPatterns),
    excludeUrlPatterns: parsePatternLines(excludeUrlPatterns),
    preserveContentLinks,
  }
}

const parsePatternLines = (value: string): string[] => {
  const seen = new Set<string>()
  const patterns: string[] = []
  for (const line of value.split(/\r?\n/)) {
    const pattern = line.trim()
    if (!pattern) continue
    const key = pattern.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    patterns.push(pattern)
  }
  return patterns
}

export interface CrawlJobMergeResult {
  jobs: WebsiteCrawlJobSummary[]
  completedJobIds: string[]
  nextStatuses: Map<string, WebsiteCrawlJobStatus>
  // Ids the caller previously marked as "recently deleted" that no longer
  // appear in the incoming server payload. Safe to drop from the dismissal
  // tracking set on the next render so the set does not grow unbounded.
  deletedJobIdsToForget: string[]
}

export function getCrawlPageIssueSummaries(
  job: Pick<WebsiteCrawlJobSummary, 'failedPageCount' | 'skippedPageCount'> | null | undefined,
): Array<{ kind: 'failed' | 'skipped'; label: string }> {
  const summaries: Array<{ kind: 'failed' | 'skipped'; label: string }> = []
  const failedPageCount = job?.failedPageCount ?? 0
  const skippedPageCount = job?.skippedPageCount ?? 0
  if (failedPageCount > 0) {
    summaries.push({ kind: 'failed', label: `${failedPageCount} failed during crawl` })
  }
  if (skippedPageCount > 0) {
    summaries.push({ kind: 'skipped', label: `${skippedPageCount} skipped during crawl` })
  }
  return summaries
}

export function applySourceResumeResult({
  sourceId,
  resumedJobCount,
  pausedSourceIds,
  crawlingSourceIds,
}: {
  sourceId: string
  resumedJobCount: number
  pausedSourceIds: ReadonlySet<string>
  crawlingSourceIds: ReadonlySet<string>
}): { pausedSourceIds: Set<string>; crawlingSourceIds: Set<string> } {
  const nextPaused = new Set(pausedSourceIds)
  const nextCrawling = new Set(crawlingSourceIds)
  if (resumedJobCount > 0) {
    nextPaused.delete(sourceId)
    nextCrawling.add(sourceId)
  }
  return {
    pausedSourceIds: nextPaused,
    crawlingSourceIds: nextCrawling,
  }
}

export async function runSourceCrawlAction<T>({
  request,
  fallbackMessage,
}: {
  request: () => Promise<T>
  fallbackMessage: string
}): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await request() }
  } catch (error) {
    return { ok: false, error: getApiErrorMessage(error, fallbackMessage) }
  }
}

export function mergeCrawlJobs({
  current,
  incoming,
  previousStatuses,
  recentlyDeletedJobIds,
}: {
  current: WebsiteCrawlJobSummary[]
  incoming: WebsiteCrawlJobSummary[]
  previousStatuses: Map<string, WebsiteCrawlJobStatus>
  recentlyDeletedJobIds?: ReadonlySet<string>
}): CrawlJobMergeResult {
  // Filter the server payload by recently-deleted ids first: a poll already in
  // flight when a DELETE landed would otherwise re-insert the dismissed row
  // until the next poll round, which looks like the dismiss button "didn't
  // work" to the user.
  const incomingFiltered = recentlyDeletedJobIds && recentlyDeletedJobIds.size > 0
    ? incoming.filter((job) => !recentlyDeletedJobIds.has(job.id))
    : incoming
  const incomingIds = new Set(incomingFiltered.map((job) => job.id))
  const completedJobIds: string[] = []
  for (const job of incomingFiltered) {
    const previous = previousStatuses.get(job.id)
    if (previous && previous !== job.status && job.status === 'completed') {
      completedJobIds.push(job.id)
    }
  }
  const optimisticOnly = current.filter((job) => !incomingIds.has(job.id))
  // Recently-deleted ids that no longer appear in the server payload have
  // been confirmed deleted server-side; let the caller forget them.
  const incomingIdSetForForget = new Set(incoming.map((job) => job.id))
  const deletedJobIdsToForget = recentlyDeletedJobIds
    ? Array.from(recentlyDeletedJobIds).filter((id) => !incomingIdSetForForget.has(id))
    : []
  return {
    jobs: [...incomingFiltered, ...optimisticOnly],
    completedJobIds,
    nextStatuses: new Map(incomingFiltered.map((job) => [job.id, job.status])),
    deletedJobIdsToForget,
  }
}
