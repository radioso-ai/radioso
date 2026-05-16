'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Database, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  documentsApi,
  type DocumentSourceListItem,
  type DocumentSummary,
  type WebsiteCrawlJobSummary,
} from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

const MANUALLY_ADDED_SOURCE_ID = '00000000-0000-0000-0000-000000000001'

const formatSourceKind = (kind: DocumentSourceListItem['kind']) => {
  switch (kind) {
    case 'website':
      return 'Website'
    case 'upload':
      return 'Uploads'
    case 'api':
      return 'API'
    case 'connector':
      return 'Connector'
    default:
      return kind
  }
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (value: string | null) => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleDateString()
}

function SourceDocumentList({ sourceId, sourceKind }: { sourceId: string; sourceKind: string }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [crawlJob, setCrawlJob] = useState<WebsiteCrawlJobSummary | null>(null)

  const loadDocuments = useCallback(async (append = false, nextCursor?: string | null) => {
    if (append) {
      setIsLoadingMore(true)
    } else {
      setIsLoading(true)
    }
    try {
      const response = await documentsApi.listSourceDocuments(sourceId, {
        limit: 25,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      })
      setDocuments((prev) => (append ? [...prev, ...response.documents] : response.documents))
      setTotal(response.total)
      setHasMore(response.hasMore)
      setCursor(response.nextCursor ?? null)
      setError(null)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load documents.'))
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [sourceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch-on-mount pattern; setState happens in async callback, not synchronously.
    void loadDocuments()
  }, [loadDocuments])

  useEffect(() => {
    if (sourceKind !== 'website') return
    void documentsApi
      .listCrawlJobs({ sourceId, limit: 1 })
      .then((response) => setCrawlJob(response.jobs[0] ?? null))
      .catch(() => {})
  }, [sourceId, sourceKind])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <LogoSpinner imageClassName="h-6 w-6" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-4 py-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1"
          onClick={() => void loadDocuments()}
        >
          Retry
        </Button>
      </div>
    )
  }

  const readyCount = documents.filter((d) => d.status === 'ready').length
  const pendingCount = documents.filter((d) => d.status === 'queued' || d.status === 'processing').length
  const failedDocCount = documents.filter((d) => d.status === 'failed').length
  const crawlInProgress = crawlJob?.status === 'queued' || crawlJob?.status === 'processing'
  const crawlPaused = crawlJob?.status === 'paused'
  const crawlFailedPages = crawlJob?.failedPageCount ?? 0
  const crawlFailures = crawlJob?.failures ?? []
  const crawlFailed = crawlJob?.status === 'failed'

  return (
    <div className="px-4 pb-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {crawlInProgress ? (
          <span>
            <Spinner className="mr-1 inline h-3 w-3" />
            Crawling…
          </span>
        ) : null}
        {crawlPaused ? (
          <span>Paused</span>
        ) : null}
        <span>{total} {total === 1 ? 'document' : 'documents'}</span>
        {readyCount > 0 ? (
          <span className="text-emerald-700 dark:text-emerald-400">{readyCount} ready</span>
        ) : null}
        {pendingCount > 0 ? (
          <span>{pendingCount} processing</span>
        ) : null}
        {failedDocCount > 0 ? (
          <span className="text-destructive">{failedDocCount} failed</span>
        ) : null}
        {crawlFailedPages > 0 ? (
          <span className="text-destructive">{crawlFailedPages} skipped during crawl</span>
        ) : null}
        {crawlFailed && crawlJob?.lastError ? (
          <span className="text-destructive">Crawl failed: {crawlJob.lastError}</span>
        ) : null}
      </div>

      {crawlFailures.length > 0 ? (
        <ul className="mb-3 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
          {crawlFailures.map((failure, index) => (
            <li key={index} className="text-xs text-destructive/80">
              <span className="font-medium">{failure.sourceUrl}</span>
              {' — '}
              {failure.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents in this source.</p>
      ) : (
        <DashboardTable minWidth="min-w-0" aria-label="Source documents">
          <DashboardTableHead>
            <DashboardTableHeader>Title</DashboardTableHeader>
            <DashboardTableHeader className="w-24 text-right">Size</DashboardTableHeader>
            <DashboardTableHeader className="w-24">Status</DashboardTableHeader>
          </DashboardTableHead>
          <DashboardTableBody>
            {documents.map((doc) => (
              <DashboardTableRow key={doc.id}>
                <DashboardTableCell>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{doc.title}</p>
                    {doc.metadata?.sourceUrl ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {String(doc.metadata.sourceUrl)}
                      </p>
                    ) : null}
                  </div>
                </DashboardTableCell>
                <DashboardTableCell>
                  <p className="text-right text-sm text-muted-foreground">
                    {doc.contentSize != null ? formatBytes(doc.contentSize) : '—'}
                  </p>
                </DashboardTableCell>
                <DashboardTableCell>
                  <span className={`text-sm ${doc.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {doc.status}
                  </span>
                </DashboardTableCell>
              </DashboardTableRow>
            ))}
          </DashboardTableBody>
        </DashboardTable>
      )}

      {hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          disabled={isLoadingMore}
          onClick={() => void loadDocuments(true, cursor)}
        >
          {isLoadingMore ? (
            <>
              <Spinner className="mr-2 h-3 w-3" />
              Loading...
            </>
          ) : (
            'Load more'
          )}
        </Button>
      ) : null}
    </div>
  )
}

export function DocumentSourcesView() {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [sources, setSources] = useState<DocumentSourceListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<DocumentSourceListItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [recrawlingSourceId, setRecrawlingSourceId] = useState<string | null>(null)
  const [pausingSourceId, setPausingSourceId] = useState<string | null>(null)
  const [resumingSourceId, setResumingSourceId] = useState<string | null>(null)
  const [crawlingSourceIds, setCrawlingSourceIds] = useState<Set<string>>(new Set())
  const [pausedSourceIds, setPausedSourceIds] = useState<Set<string>>(new Set())
  const sectionShellClassName = 'w-full'

  const refreshCrawlingStatus = useCallback(() => {
    void Promise.all([
      documentsApi.listCrawlJobs({ sinceMinutes: 60 }),
      documentsApi.listCrawlJobs({ status: 'paused' }),
    ])
      .then(([recentResponse, pausedResponse]) => {
        const jobsById = new Map(recentResponse.jobs.map((job) => [job.id, job]))
        for (const job of pausedResponse.jobs) {
          jobsById.set(job.id, job)
        }
        const active = new Set<string>()
        const paused = new Set<string>()
        const staleThresholdMs = 10 * 60 * 1000
        for (const job of jobsById.values()) {
          if (!job.sourceId) continue
          if (job.status === 'queued') {
            active.add(job.sourceId)
          } else if (job.status === 'paused') {
            paused.add(job.sourceId)
          } else if (job.status === 'processing') {
            const age = Date.now() - new Date(job.updatedAt).getTime()
            if (age < staleThresholdMs) {
              active.add(job.sourceId)
            }
          }
        }
        setCrawlingSourceIds(active)
        setPausedSourceIds(paused)
      })
      .catch(() => {})
  }, [])

  const loadSources = async () => {
    if (isWorkspaceLoading) {
      setIsLoading(true)
      return
    }

    if (!activeWorkspaceId) {
      setSources([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const response = await documentsApi.listSources()
      setSources(response.sources)
      setError(null)
    } catch (loadError) {
      setSources([])
      setError(getApiErrorMessage(loadError, 'Failed to load sources.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Load request sets source list/error state in this effect.
    void loadSources()
    refreshCrawlingStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, isWorkspaceLoading])

  useEffect(() => {
    if (crawlingSourceIds.size === 0) return
    const interval = setInterval(() => {
      refreshCrawlingStatus()
    }, 5000)
    return () => clearInterval(interval)
  }, [crawlingSourceIds.size, refreshCrawlingStatus])

  const handleRecrawl = async (source: DocumentSourceListItem) => {
    setRecrawlingSourceId(source.id)
    try {
      await documentsApi.recrawlSource(source.id)
      setCrawlingSourceIds((prev) => new Set([...prev, source.id]))
      setPausedSourceIds((prev) => {
        const next = new Set(prev)
        next.delete(source.id)
        return next
      })
      void loadSources()
    } catch {
      // Recrawl failure is visible via the crawl jobs banner
    } finally {
      setRecrawlingSourceId(null)
    }
  }

  const handlePause = async (source: DocumentSourceListItem) => {
    setPausingSourceId(source.id)
    try {
      await documentsApi.pauseSourceCrawl(source.id)
      setCrawlingSourceIds((prev) => {
        const next = new Set(prev)
        next.delete(source.id)
        return next
      })
      setPausedSourceIds((prev) => new Set([...prev, source.id]))
      refreshCrawlingStatus()
      void loadSources()
    } finally {
      setPausingSourceId(null)
    }
  }

  const handleResume = async (source: DocumentSourceListItem) => {
    setResumingSourceId(source.id)
    try {
      await documentsApi.resumeSourceCrawl(source.id)
      setPausedSourceIds((prev) => {
        const next = new Set(prev)
        next.delete(source.id)
        return next
      })
      setCrawlingSourceIds((prev) => new Set([...prev, source.id]))
      refreshCrawlingStatus()
      void loadSources()
    } finally {
      setResumingSourceId(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteCandidate) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await documentsApi.deleteSource(deleteCandidate.id)
      setDeleteCandidate(null)
      if (expandedSourceId === deleteCandidate.id) {
        setExpandedSourceId(null)
      }
      void loadSources()
    } catch (err) {
      setDeleteError(getApiErrorMessage(err, 'Failed to delete source.'))
    } finally {
      setIsDeleting(false)
    }
  }

  const canRecrawl = (source: DocumentSourceListItem) =>
    source.kind === 'website' && source.id !== MANUALLY_ADDED_SOURCE_ID

  const canDelete = (source: DocumentSourceListItem) =>
    source.id !== MANUALLY_ADDED_SOURCE_ID

  if (isLoading) {
    return (
      <div className={`${sectionShellClassName} space-y-4`}>
        <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`${sectionShellClassName} flex min-h-48 flex-col items-start justify-center gap-3`}>
        <div>
          <p className="font-medium text-foreground">Unable to load sources</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadSources()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  if (sources.length === 0) {
    return (
      <div className={`${sectionShellClassName} flex min-h-48 flex-col items-start justify-center gap-2`}>
        <Database className="h-5 w-5 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">No sources yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Sources appear after website crawls or uploaded files create persisted source records.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`${sectionShellClassName} space-y-4`}>
      <DashboardTable aria-label="Document sources">
        <DashboardTableHead>
          <DashboardTableHeader className="w-10" />
          <DashboardTableHeader>Source</DashboardTableHeader>
          <DashboardTableHeader className="w-32">Kind</DashboardTableHeader>
          <DashboardTableHeader className="w-24 text-right">Documents</DashboardTableHeader>
          <DashboardTableHeader className="w-36">Last sync</DashboardTableHeader>
          <DashboardTableHeader className="w-28" />
        </DashboardTableHead>
        <DashboardTableBody>
          {sources.map((source) => {
            const isExpanded = expandedSourceId === source.id
            return (
              <tr key={source.id} className="group border-b border-border last:border-b-0">
                <td colSpan={6} className="p-0">
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex cursor-pointer items-center hover:bg-accent/20"
                    onClick={() => setExpandedSourceId(isExpanded ? null : source.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setExpandedSourceId(isExpanded ? null : source.id)
                      }
                    }}
                  >
                    <div className="w-10 px-4 py-3 text-muted-foreground">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{source.name}</p>
                        {source.externalId ? (
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {source.externalId}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="w-32 px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {formatSourceKind(source.kind)}
                      </span>
                    </div>
                    <div className="w-24 px-4 py-3">
                      <p className="text-right text-sm text-muted-foreground">
                        {source.documentCount}
                      </p>
                    </div>
                    <div className="w-36 px-4 py-3">
                      <p className="text-sm text-muted-foreground">
                        {formatDate(source.lastSyncedAt)}
                      </p>
                    </div>
                    <div className="w-28 px-2 py-3">
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {canRecrawl(source) ? (() => {
                          const isCrawling = crawlingSourceIds.has(source.id) || recrawlingSourceId === source.id
                          const isPaused = pausedSourceIds.has(source.id)
                          const isPausing = pausingSourceId === source.id
                          const isResuming = resumingSourceId === source.id
                          if (isCrawling) {
                            return (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                disabled={isPausing}
                                title="Pause crawl"
                                onClick={() => void handlePause(source)}
                              >
                                {isPausing ? <Spinner className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                              </Button>
                            )
                          }
                          if (isPaused) {
                            return (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                disabled={isResuming}
                                title="Resume crawl"
                                onClick={() => void handleResume(source)}
                              >
                                {isResuming ? <Spinner className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                              </Button>
                            )
                          }
                          return (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              disabled={recrawlingSourceId === source.id}
                              title="Re-crawl"
                              onClick={() => void handleRecrawl(source)}
                            >
                              <RefreshCw className={`h-3.5 w-3.5 ${recrawlingSourceId === source.id ? 'animate-spin' : ''}`} />
                            </Button>
                          )
                        })() : null}
                        {canDelete(source) ? (
                          <button
                            type="button"
                            aria-label={`Delete ${source.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              setDeleteError(null)
                              setDeleteCandidate(source)
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {isExpanded ? (
                    <div className="border-t border-border bg-muted/10">
                      <SourceDocumentList sourceId={source.id} sourceKind={source.kind} />
                    </div>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </DashboardTableBody>
      </DashboardTable>

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteCandidate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete source?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{' '}
              <span className="font-medium text-foreground">
                {deleteCandidate?.name ?? 'this source'}
              </span>{' '}
              and all {deleteCandidate?.documentCount ?? 0} associated{' '}
              {deleteCandidate?.documentCount === 1 ? 'document' : 'documents'} from your knowledge
              base.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-sm text-destructive" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleDeleteConfirm()
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
