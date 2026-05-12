'use client'

import { CheckCircle2, Globe, Loader2, X, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { WebsiteCrawlJobSummary, WebsiteCrawlJobStatus } from '@/lib/api'

const STATUS_LABELS: Record<WebsiteCrawlJobStatus, string> = {
  queued: 'Queued',
  processing: 'Crawling',
  completed: 'Completed',
  failed: 'Failed',
}

function StatusBadge({ status }: { status: WebsiteCrawlJobStatus }) {
  if (status === 'queued') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  if (status === 'processing') {
    return (
      <Badge variant="secondary">
        <Loader2 className="h-3 w-3 animate-spin" />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  if (status === 'completed') {
    return (
      <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-destructive/50 text-destructive">
      <XCircle className="h-3 w-3" />
      {STATUS_LABELS[status]}
    </Badge>
  )
}

function describeOutcome(job: WebsiteCrawlJobSummary): string | null {
  if (job.status === 'completed') {
    if (job.documentCount === null) {
      return null
    }
    if (job.documentCount === 0) {
      return 'No pages indexed — site may have blocked the crawler.'
    }
    return `${job.documentCount} ${job.documentCount === 1 ? 'page' : 'pages'} added.`
  }
  if (job.status === 'failed') {
    return job.lastError ?? 'Crawl failed.'
  }
  return null
}

export function DocumentCrawlJobsBanner({
  jobs,
  onDismiss,
  dismissingJobIds,
}: {
  jobs: WebsiteCrawlJobSummary[]
  onDismiss: (job: WebsiteCrawlJobSummary) => void
  dismissingJobIds: Set<string>
}) {
  if (jobs.length === 0) {
    return null
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
      <ul className="space-y-2">
        {jobs.map((job) => {
          const outcome = describeOutcome(job)
          const isTerminal = job.status === 'completed' || job.status === 'failed'
          const isDismissing = dismissingJobIds.has(job.id)
          return (
            <li
              key={job.id}
              className="flex items-start gap-3 rounded-md border border-border bg-background p-3"
            >
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground" title={job.requestedUrl}>
                    {job.requestedUrl}
                  </span>
                  <StatusBadge status={job.status} />
                </div>
                {outcome ? (
                  <p
                    className={`mt-1 text-xs ${job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {outcome}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={isTerminal ? 'Delete crawl job' : 'Dismiss crawl status'}
                  title={isTerminal ? 'Delete this crawl job' : 'Hide until next refresh'}
                  onClick={() => onDismiss(job)}
                  disabled={isDismissing}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
                >
                  {isDismissing ? <Spinner className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
