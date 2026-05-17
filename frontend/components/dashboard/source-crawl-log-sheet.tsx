'use client'

import { useEffect, useState } from 'react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  documentsApi,
  type DocumentSourceListItem,
  type WebsiteCrawlJobSummary,
} from '@/lib/api'
import { getCrawlPageIssueSummaries } from '@/lib/crawl-jobs'

interface SourceCrawlLogSheetProps {
  source: DocumentSourceListItem | null
  onOpenChange: (open: boolean) => void
}

export function SourceCrawlLogSheet({ source, onOpenChange }: SourceCrawlLogSheetProps) {
  const [crawlJob, setCrawlJob] = useState<WebsiteCrawlJobSummary | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!source) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear cached crawl log when sheet closes (source becomes null).
      setCrawlJob(null)
       
      setError(null)
      return
    }
    let cancelled = false
     
    setIsLoading(true)
     
    setError(null)
    void documentsApi
      .listCrawlJobs({ sourceId: source.id, limit: 1 })
      .then((response) => {
        if (!cancelled) {
          setCrawlJob(response.jobs[0] ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load crawl log.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [source])

  const pageIssueSummaries = getCrawlPageIssueSummaries(crawlJob)
  const failures = crawlJob?.failures ?? []
  const open = source !== null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Crawl log</SheetTitle>
          <SheetDescription>
            {source ? source.name : 'Coverage and failures for the latest crawl run.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <LogoSpinner imageClassName="h-6 w-6" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : !crawlJob ? (
            <p className="text-sm text-muted-foreground">No crawl run recorded yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Status: {crawlJob.status}</span>
                {pageIssueSummaries.map((summary) => (
                  <span
                    key={summary.kind}
                    className={summary.kind === 'failed' ? 'text-destructive' : undefined}
                  >
                    {summary.label}
                  </span>
                ))}
                {crawlJob.lastError ? (
                  <span className="text-destructive">Last error: {crawlJob.lastError}</span>
                ) : null}
              </div>
              {failures.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No skipped or failed URLs recorded for the latest crawl run.
                </p>
              ) : (
                <ul className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
                  {failures.map((failure, index) => (
                    <li key={index} className="text-xs text-destructive/80">
                      <span className="font-medium">{failure.sourceUrl}</span>
                      {' — '}
                      {failure.reason}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
