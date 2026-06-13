'use client'

import { AlertTriangle, CheckCircle2, Globe, Loader2, Pause, RotateCcw, X, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { summarizeCrawlFailureReason } from '@/lib/crawl-jobs'
import type { WebsiteCrawlJobSummary, WebsiteCrawlJobStatus } from '@/lib/api'

const STATUS_LABELS: Record<WebsiteCrawlJobStatus, string> = {
  queued: 'Queued',
  processing: 'Crawling',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
}

// A completed crawl that indexed zero pages is a failed outcome, not a success,
// so it is styled as a warning rather than with the green "Completed" badge.
const isEmptyCompletion = (job: WebsiteCrawlJobSummary): boolean =>
  job.status === 'completed' && job.documentCount === 0

function StatusBadge({ job }: { job: WebsiteCrawlJobSummary }) {
  const { status } = job
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
    if (isEmptyCompletion(job)) {
      return (
        <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          No pages indexed
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  if (status === 'paused') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Pause className="h-3 w-3" />
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
      // Surface the reason the crawler actually recorded rather than guessing a
      // cause (a guess like "site blocked the crawler" can contradict the log).
      const reason = summarizeCrawlFailureReason(job.failures)
      return reason ? `No pages indexed — ${reason}.` : 'No pages were indexed.'
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
  onRetry,
  dismissingJobIds,
}: {
  jobs: WebsiteCrawlJobSummary[]
  onDismiss: (job: WebsiteCrawlJobSummary) => void
  onRetry?: (job: WebsiteCrawlJobSummary) => void
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
          const isUnsuccessful = job.status === 'failed' || isEmptyCompletion(job)
          const canRetry = Boolean(onRetry) && isUnsuccessful
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
                  <StatusBadge job={job} />
                </div>
                {outcome ? (
                  <p
                    className={`mt-1 text-xs ${isUnsuccessful ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {outcome}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canRetry ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => onRetry?.(job)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                ) : null}
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
