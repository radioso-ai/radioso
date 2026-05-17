'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Settings2,
  Trash2,
} from 'lucide-react'

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
  DashboardTableHead,
  DashboardTableHeader,
} from '@/components/dashboard/shared/dashboard-table'
import { SourceCrawlLogSheet } from '@/components/dashboard/source-crawl-log-sheet'
import { getApiErrorMessage } from '@/lib/api-error'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CrawlPolicyFields } from '@/components/dashboard/documents/crawl-policy-fields'
import {
  documentsApi,
  type DocumentSourceCrawlSettings,
  type DocumentSourceListItem,
  type WebsiteCrawlJobSummary,
} from '@/lib/api'
import {
  applySourceResumeResult,
  getCrawlPageIssueSummaries,
  getResumeDispatchWarning,
  runSourceCrawlAction,
} from '@/lib/crawl-jobs'
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

const formatDate = (value: string | null) => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleDateString()
}

interface DocumentSourcesViewProps {
  onViewDocumentsForSource: (sourceId: string) => void
}

const splitPatterns = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

function SourceCrawlSettingsForm({
  source,
  onSaved,
}: {
  source: DocumentSourceListItem
  onSaved: (settings: DocumentSourceCrawlSettings) => void
}) {
  const initial = source.crawlSettings
  const [limitInput, setLimitInput] = useState<string>(initial ? String(initial.limit) : '')
  const [includeInput, setIncludeInput] = useState<string>(initial?.includeUrlPatterns.join('\n') ?? '')
  const [excludeInput, setExcludeInput] = useState<string>(initial?.excludeUrlPatterns.join('\n') ?? '')
  const [preserveContentLinks, setPreserveContentLinks] = useState<boolean>(initial?.preserveContentLinks ?? true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!initial) {
    return null
  }

  const parsedLimit = Number.parseInt(limitInput, 10)
  const limitValid = Number.isFinite(parsedLimit) && parsedLimit > 0
  const includePatterns = splitPatterns(includeInput)
  const excludePatterns = splitPatterns(excludeInput)
  const includeUnchanged =
    includePatterns.length === initial.includeUrlPatterns.length &&
    includePatterns.every((value, index) => value === initial.includeUrlPatterns[index])
  const excludeUnchanged =
    excludePatterns.length === initial.excludeUrlPatterns.length &&
    excludePatterns.every((value, index) => value === initial.excludeUrlPatterns[index])
  const isDirty =
    (limitValid && parsedLimit !== initial.limit) ||
    !includeUnchanged ||
    !excludeUnchanged ||
    preserveContentLinks !== initial.preserveContentLinks

  const handleSave = async () => {
    if (!limitValid || !isDirty) {
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      const updated = await documentsApi.updateSourceCrawlSettings(source.id, {
        limit: parsedLimit,
        includeUrlPatterns: includePatterns,
        excludeUrlPatterns: excludePatterns,
        preserveContentLinks,
      })
      if (updated.crawlSettings) {
        onSaved(updated.crawlSettings)
      }
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to save crawl settings.'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      <CrawlPolicyFields
        idPrefix={`source-${source.id}`}
        limit={limitInput}
        includeUrlPatterns={includeInput}
        excludeUrlPatterns={excludeInput}
        preserveContentLinks={preserveContentLinks}
        disabled={isSaving}
        onLimitChange={setLimitInput}
        onIncludeUrlPatternsChange={setIncludeInput}
        onExcludeUrlPatternsChange={setExcludeInput}
        onPreserveContentLinksChange={setPreserveContentLinks}
      />
      {!limitValid ? (
        <p className="text-xs text-destructive">Page limit must be a positive integer.</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!isDirty || !limitValid || isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? (
            <>
              <Spinner className="mr-2 h-3 w-3" />
              Saving…
            </>
          ) : (
            'Save settings'
          )}
        </Button>
      </div>
    </div>
  )
}

function SourceExpandedPanel({
  source,
  crawlStatusVersion,
  isResumePending,
  onViewDocuments,
  onOpenCrawlLog,
  onSettingsSaved,
}: {
  source: DocumentSourceListItem
  crawlStatusVersion: number
  isResumePending: boolean
  onViewDocuments: () => void
  onOpenCrawlLog: () => void
  onSettingsSaved: (settings: DocumentSourceCrawlSettings) => void
}) {
  const [crawlJob, setCrawlJob] = useState<WebsiteCrawlJobSummary | null>(null)
  const [isLoading, setIsLoading] = useState(source.kind === 'website')

  useEffect(() => {
    if (source.kind !== 'website') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync derived loading flag when source kind has no crawl data to load.
      setIsLoading(false)
      return
    }
    let cancelled = false
     
    setIsLoading(true)
    void documentsApi
      .listCrawlJobs({ sourceId: source.id, limit: 1 })
      .then((response) => {
        if (!cancelled) {
          setCrawlJob(response.jobs[0] ?? null)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [source.id, source.kind, crawlStatusVersion])

  const crawlInProgress = crawlJob?.status === 'queued' || crawlJob?.status === 'processing' || isResumePending
  const crawlPaused = crawlJob?.status === 'paused' && !isResumePending
  const crawlFailed = crawlJob?.status === 'failed'
  const pageIssueSummaries = getCrawlPageIssueSummaries(crawlJob)
  const hasCrawlLog = source.kind === 'website' && Boolean(crawlJob)

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {isLoading ? (
          <span>
            <Spinner className="mr-1 inline h-3 w-3" />
            Loading status…
          </span>
        ) : (
          <>
            {crawlInProgress ? (
              <span>
                <Spinner className="mr-1 inline h-3 w-3" />
                Crawling…
              </span>
            ) : null}
            {crawlPaused ? <span>Paused</span> : null}
            <span>
              {source.documentCount} {source.documentCount === 1 ? 'document' : 'documents'}
            </span>
            {pageIssueSummaries.map((summary) => (
              <span
                key={summary.kind}
                className={summary.kind === 'failed' ? 'text-destructive' : undefined}
              >
                {summary.label}
              </span>
            ))}
            {crawlFailed && crawlJob?.lastError ? (
              <span className="text-destructive">Crawl failed: {crawlJob.lastError}</span>
            ) : null}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onViewDocuments}>
          <FileText className="mr-2 h-3.5 w-3.5" />
          View documents
        </Button>
        {hasCrawlLog ? (
          <Button type="button" variant="outline" size="sm" onClick={onOpenCrawlLog}>
            <ScrollText className="mr-2 h-3.5 w-3.5" />
            View crawl log
          </Button>
        ) : null}
      </div>
      {source.kind === 'website' && source.crawlSettings ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
              <Settings2 className="mr-2 h-3.5 w-3.5" />
              Advanced crawl settings
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <SourceCrawlSettingsForm source={source} onSaved={onSettingsSaved} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}

export function DocumentSourcesView({ onViewDocumentsForSource }: DocumentSourcesViewProps) {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [sources, setSources] = useState<DocumentSourceListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)
  const [crawlLogSource, setCrawlLogSource] = useState<DocumentSourceListItem | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<DocumentSourceListItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [crawlActionError, setCrawlActionError] = useState<string | null>(null)
  const [recrawlingSourceId, setRecrawlingSourceId] = useState<string | null>(null)
  const [pausingSourceId, setPausingSourceId] = useState<string | null>(null)
  const [resumingSourceId, setResumingSourceId] = useState<string | null>(null)
  const [crawlingSourceIds, setCrawlingSourceIds] = useState<Set<string>>(new Set())
  const [pausedSourceIds, setPausedSourceIds] = useState<Set<string>>(new Set())
  const [pendingResumeSourceIds, setPendingResumeSourceIds] = useState<Set<string>>(new Set())
  const [crawlStatusVersion, setCrawlStatusVersion] = useState(0)
  const sectionShellClassName = 'w-full'

  const refreshCrawlingStatus = useCallback((pendingResumeSourceIdsOverride?: ReadonlySet<string>) => {
    void Promise.all([
      documentsApi.listCrawlJobs({ sinceMinutes: 60 }),
      documentsApi.listCrawlJobs({ status: 'paused' }),
    ])
      .then(([recentResponse, pausedResponse]) => {
        const effectivePendingResumeSourceIds = pendingResumeSourceIdsOverride ?? pendingResumeSourceIds
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
        const nextPendingResumeSourceIds = new Set(effectivePendingResumeSourceIds)
        let pendingResumeChanged = false
        for (const sourceId of effectivePendingResumeSourceIds) {
          if (!paused.has(sourceId)) {
            nextPendingResumeSourceIds.delete(sourceId)
            pendingResumeChanged = true
            continue
          }
          paused.delete(sourceId)
          active.add(sourceId)
        }
        if (pendingResumeChanged) {
          setPendingResumeSourceIds(nextPendingResumeSourceIds)
          setCrawlStatusVersion((version) => version + 1)
        }
        setCrawlingSourceIds(active)
        setPausedSourceIds(paused)
      })
      .catch(() => {})
  }, [pendingResumeSourceIds])

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
    const nextPendingResumeSourceIds = new Set(pendingResumeSourceIds)
    nextPendingResumeSourceIds.delete(source.id)
    setPendingResumeSourceIds(nextPendingResumeSourceIds)
    try {
      await documentsApi.recrawlSource(source.id)
      setCrawlingSourceIds((prev) => new Set([...prev, source.id]))
      setPausedSourceIds((prev) => {
        const next = new Set(prev)
        next.delete(source.id)
        return next
      })
      setCrawlStatusVersion((version) => version + 1)
      refreshCrawlingStatus(nextPendingResumeSourceIds)
    } catch {
      // Recrawl failure is visible via the crawl jobs banner
    } finally {
      setRecrawlingSourceId(null)
    }
  }

  const handlePause = async (source: DocumentSourceListItem) => {
    setPausingSourceId(source.id)
    setCrawlActionError(null)
    const nextPendingResumeSourceIds = new Set(pendingResumeSourceIds)
    nextPendingResumeSourceIds.delete(source.id)
    setPendingResumeSourceIds(nextPendingResumeSourceIds)
    try {
      const result = await runSourceCrawlAction({
        request: () => documentsApi.pauseSourceCrawl(source.id),
        fallbackMessage: 'Failed to pause crawl.',
      })
      if (!result.ok) {
        setCrawlActionError(result.error)
        return
      }
      setCrawlingSourceIds((prev) => {
        const next = new Set(prev)
        next.delete(source.id)
        return next
      })
      setPausedSourceIds((prev) => new Set([...prev, source.id]))
      setCrawlStatusVersion((version) => version + 1)
      refreshCrawlingStatus(nextPendingResumeSourceIds)
    } finally {
      setPausingSourceId(null)
    }
  }

  const handleResume = async (source: DocumentSourceListItem) => {
    setResumingSourceId(source.id)
    setCrawlActionError(null)
    try {
      const result = await runSourceCrawlAction({
        request: () => documentsApi.resumeSourceCrawl(source.id),
        fallbackMessage: 'Failed to resume crawl.',
      })
      if (!result.ok) {
        setCrawlActionError(result.error)
        return
      }
      const resumeDispatchWarning = getResumeDispatchWarning(result.result)
      if (resumeDispatchWarning) {
        setCrawlActionError(resumeDispatchWarning)
      }
      const pendingResumeJobCount = result.result.pendingResumeJobCount ?? 0
      if (pendingResumeJobCount > 0) {
        setPendingResumeSourceIds((prev) => new Set([...prev, source.id]))
      }
      setPausedSourceIds((prev) => applySourceResumeResult({
        sourceId: source.id,
        resumedJobCount: result.result.resumedJobCount,
        pendingResumeJobCount: result.result.pendingResumeJobCount,
        pausedSourceIds: prev,
        crawlingSourceIds: new Set(),
      }).pausedSourceIds)
      setCrawlingSourceIds((prev) => applySourceResumeResult({
        sourceId: source.id,
        resumedJobCount: result.result.resumedJobCount,
        pendingResumeJobCount: result.result.pendingResumeJobCount,
        pausedSourceIds: new Set(),
        crawlingSourceIds: prev,
      }).crawlingSourceIds)
      setCrawlStatusVersion((version) => version + 1)
      if (pendingResumeJobCount === 0) {
        refreshCrawlingStatus()
      }
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
      {crawlActionError ? (
        <p className="text-sm text-destructive" role="alert">
          {crawlActionError}
        </p>
      ) : null}
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
                    aria-expanded={isExpanded}
                    className="flex cursor-pointer items-center hover:bg-accent/20"
                    onClick={() => setExpandedSourceId(isExpanded ? null : source.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
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
                          <p className="mt-1 truncate text-xs text-muted-foreground">{source.externalId}</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="w-32 px-4 py-3">
                      <span className="text-sm text-muted-foreground">{formatSourceKind(source.kind)}</span>
                    </div>
                    <div className="w-24 px-4 py-3">
                      <p className="text-right text-sm text-muted-foreground">{source.documentCount}</p>
                    </div>
                    <div className="w-36 px-4 py-3">
                      <p className="text-sm text-muted-foreground">{formatDate(source.lastSyncedAt)}</p>
                    </div>
                    <div className="w-28 px-2 py-3">
                      <div
                        className="flex items-center gap-1"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                        role="presentation"
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
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void handlePause(source)
                                }}
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
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void handleResume(source)
                                }}
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
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                void handleRecrawl(source)
                              }}
                            >
                              <RefreshCw
                                className={`h-3.5 w-3.5 ${recrawlingSourceId === source.id ? 'animate-spin' : ''}`}
                              />
                            </Button>
                          )
                        })() : null}
                        {canDelete(source) ? (
                          <button
                            type="button"
                            aria-label={`Delete ${source.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-destructive hover:bg-destructive/10"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
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
                      <SourceExpandedPanel
                        source={source}
                        crawlStatusVersion={crawlStatusVersion}
                        isResumePending={pendingResumeSourceIds.has(source.id)}
                        onViewDocuments={() => onViewDocumentsForSource(source.id)}
                        onOpenCrawlLog={() => setCrawlLogSource(source)}
                        onSettingsSaved={(settings) => {
                          setSources((current) =>
                            current.map((entry) =>
                              entry.id === source.id ? { ...entry, crawlSettings: settings } : entry,
                            ),
                          )
                        }}
                      />
                    </div>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </DashboardTableBody>
      </DashboardTable>

      <SourceCrawlLogSheet
        source={crawlLogSource}
        onOpenChange={(open) => {
          if (!open) setCrawlLogSource(null)
        }}
      />

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
              onClick={(event) => {
                event.preventDefault()
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
