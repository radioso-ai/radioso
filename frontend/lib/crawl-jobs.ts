import type { WebsiteCrawlJobStatus, WebsiteCrawlJobSummary } from '@/lib/api'

export type ParsedCrawlForm =
  | { ok: true; url: string; limit?: number }
  | { ok: false; error: string }

export function parseCrawlForm({
  url,
  limit,
  maxLimit,
}: {
  url: string
  limit: string
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
    return { ok: true, url: trimmedUrl }
  }

  const value = Number.parseInt(trimmedLimit, 10)
  if (!Number.isFinite(value) || value < 1 || String(value) !== trimmedLimit) {
    return { ok: false, error: 'Page limit must be a positive whole number.' }
  }

  return { ok: true, url: trimmedUrl, limit: Math.min(value, maxLimit) }
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
