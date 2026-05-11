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
}

export function mergeCrawlJobs({
  current,
  incoming,
  previousStatuses,
}: {
  current: WebsiteCrawlJobSummary[]
  incoming: WebsiteCrawlJobSummary[]
  previousStatuses: Map<string, WebsiteCrawlJobStatus>
}): CrawlJobMergeResult {
  const incomingIds = new Set(incoming.map((job) => job.id))
  const completedJobIds: string[] = []
  for (const job of incoming) {
    const previous = previousStatuses.get(job.id)
    if (previous && previous !== job.status && job.status === 'completed') {
      completedJobIds.push(job.id)
    }
  }
  const optimisticOnly = current.filter((job) => !incomingIds.has(job.id))
  return {
    jobs: [...incoming, ...optimisticOnly],
    completedJobIds,
    nextStatuses: new Map(incoming.map((job) => [job.id, job.status])),
  }
}
