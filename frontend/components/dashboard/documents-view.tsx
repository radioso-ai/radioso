'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { AddDocumentMenu, type AddDocumentAction } from '@/components/dashboard/documents/add-document-menu'
import { DocumentCrawlDialog } from '@/components/dashboard/documents/document-crawl-dialog'
import { DocumentCrawlJobsBanner } from '@/components/dashboard/documents/document-crawl-jobs-banner'
import { DocumentDeleteDialog } from '@/components/dashboard/documents/document-delete-dialog'
import { DocumentEditorDialog } from '@/components/dashboard/documents/document-editor-dialog'
import {
  ActiveFilterPills,
  FilterDialog,
  type FilterDefinition,
  type FilterValues,
} from '@/components/dashboard/shared/filters'
import {
  DocumentEditorPage,
  MANUALLY_ADDED_SOURCE_ID,
  type DocumentEditorValues,
} from '@/components/dashboard/documents/document-editor-page'
import { ConnectorSetupDialog } from '@/components/dashboard/documents/connector-setup-dialog'
import { DocumentImportDialog } from '@/components/dashboard/documents/document-import-dialog'
import {
  ChunkInspectorSheet,
  type ChunkInspectorRequest,
} from '@/components/dashboard/documents/chunk-inspector-sheet'
import { DocumentList } from '@/components/dashboard/documents/document-list'
import {
  toRecord as metadataToRecord,
  toRows as metadataToRows,
  type MetadataRecord,
} from '@/components/dashboard/shared/metadata-key-value-rows'
import { DocumentSearchBar } from '@/components/dashboard/document-search-bar'
import { DocumentSearchResults } from '@/components/dashboard/document-search-results'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { useDocumentSearch } from '@/components/dashboard/use-document-search'
import { Button } from '@/components/ui/button'
import { useDashboardQueryInvalidation, useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import {
  type DocumentSourceListItem,
  type DocumentSummary,
  type WebsiteCrawlJobSummary,
  documentsApi,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { mergeCrawlJobs, parseCrawlForm } from '@/lib/crawl-jobs'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import {
  DOCUMENT_CRAWL_RECENT_SINCE_MINUTES,
  effectiveCrawlPresentation,
  isInitialDocumentListLoading,
  patchDocumentListRow,
  removeDocumentListRow,
  useDocumentCrawlActivityQuery,
  useDocumentListQuery,
} from '@/lib/documents-query-state'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { getSafeDocumentsPage } from '@/lib/documents-pagination'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import {
  consumeAudiencePulseDraftSeed,
  formatDraftQuestionsAsMarkdown,
  type AudiencePulseDraftSeed,
} from '@/lib/audience-pulse-draft-seed'

const PAGE_SIZE = 100
const EMPTY_DOCUMENTS: DocumentSummary[] = []
const SUPPORTED_IMPORT_EXTENSIONS = '.pdf,.txt,.md,.markdown,.docx,.xlsx'
const CRAWL_MAX_LIMIT = 1000

const EMPTY_FORM: DocumentEditorValues = {
  title: '',
  content: '',
  metadata: {},
  sourceId: MANUALLY_ADDED_SOURCE_ID,
}

const INVALID_METADATA_MESSAGE = 'Fix the highlighted tags before saving.'

/**
 * Narrows a stored metadata record to the flat scalars the editor authors, so a
 * value the pipeline wrote in some richer shape is never round-tripped back as a
 * mangled string.
 */
const toEditableMetadata = (metadata: unknown): MetadataRecord =>
  metadataToRecord(metadataToRows((metadata ?? {}) as Record<string, unknown>))

interface DocumentsViewProps {
  routeState: DashboardRouteState
  accountId: string
  selectedDocumentId?: string | null
  onSelectedDocumentChange?: (documentId: string | null) => void
  onboarding: WorkspaceOnboardingState
  navigation?: ReactNode
  // When set, open the matching add dialog on mount (used by the Sources tab's
  // "Add" menu, which routes here so the canonical add flows are reused).
  autoOpenAdd?: AddDocumentAction | null
  onAutoOpenAddHandled?: () => void
}

export function DocumentsView({
  routeState,
  accountId,
  selectedDocumentId = null,
  onSelectedDocumentChange,
  onboarding,
  navigation,
  autoOpenAdd = null,
  onAutoOpenAddHandled,
}: DocumentsViewProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const invalidateDashboardQueries = useDashboardQueryInvalidation()
  const { intervalFor, queriesEnabled } = useDashboardQueryPolicy()
  const justClosedDocumentIdRef = useRef<string | null>(null)
  const previousCrawlJobsRef = useRef<Map<string, WebsiteCrawlJobSummary['status']>>(new Map())
  const recentlyDeletedRef = useRef<Set<string>>(new Set())
  const documentSearch = useDocumentSearch()
  const audiencePulseDraftSeedRef = useRef<{
    seed: AudiencePulseDraftSeed | null
    consumed: boolean
    dismissed: boolean
  }>({ seed: null, consumed: false, dismissed: false })

  const [currentPage, setCurrentPage] = useState(routeState.documentsPage ?? 1)
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [isDocumentLoading, setIsDocumentLoading] = useState(false)
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null)
  const [activeDocument, setActiveDocument] = useState<DocumentSummary | null>(null)
  const [isEditingDetail, setIsEditingDetail] = useState(false)
  const [isMetadataSheetOpen, setIsMetadataSheetOpen] = useState(false)
  const [formValues, setFormValues] = useState<DocumentEditorValues>(EMPTY_FORM)
  const [importTitle, setImportTitle] = useState('')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importMetadata, setImportMetadata] = useState<MetadataRecord>({})
  const [isImportMetadataValid, setIsImportMetadataValid] = useState(true)
  const [importEnrichmentChoice, setImportEnrichmentChoice] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [isSavingMetadata, setIsSavingMetadata] = useState(false)
  const [metadataSaveError, setMetadataSaveError] = useState<string | null>(null)
  const [extractingDocumentId, setExtractingDocumentId] = useState<string | null>(null)
  const [isUpdatingRetrieval, setIsUpdatingRetrieval] = useState(false)
  const [retrievalError, setRetrievalError] = useState<string | null>(null)
  const [createEnrichmentChoice, setCreateEnrichmentChoice] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [importError, setImportError] = useState<string | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<DocumentSummary | null>(null)
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null)
  const [deleteErrorById, setDeleteErrorById] = useState<Record<string, string>>({})
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null)
  const [retryErrorById, setRetryErrorById] = useState<Record<string, string>>({})
  const [chunkInspectorRequest, setChunkInspectorRequest] = useState<ChunkInspectorRequest>(null)
  const [availableSources, setAvailableSources] = useState<DocumentSourceListItem[]>([])
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
  const [activeConnectorId, setActiveConnectorId] = useState<string | null>(null)

  const sourceFilterId = routeState.documentSourceFilter ?? null
  const workspaceId = routeState.workspaceId ?? ''
  const documentFilters = useMemo<ReadonlyArray<FilterDefinition>>(
    () => [
      {
        id: 'source',
        kind: 'single-select',
        label: 'Source',
        placeholder: 'All sources',
        options: availableSources.map((source) => ({ value: source.id, label: source.name })),
      },
    ],
    [availableSources],
  )
  const filterValues = useMemo<FilterValues>(
    () => (sourceFilterId ? { source: { kind: 'single-select', value: sourceFilterId } } : {}),
    [sourceFilterId],
  )
  const [isCrawlDialogOpen, setIsCrawlDialogOpen] = useState(false)
  const [isCrawling, setIsCrawling] = useState(false)
  const [crawlUrl, setCrawlUrl] = useState('')
  const [crawlLimit, setCrawlLimit] = useState('')
  const [crawlIncludeUrlPatterns, setCrawlIncludeUrlPatterns] = useState('')
  const [crawlExcludeUrlPatterns, setCrawlExcludeUrlPatterns] = useState('')
  const [crawlPreserveContentLinks, setCrawlPreserveContentLinks] = useState(true)
  const [crawlError, setCrawlError] = useState<string | null>(null)
  const [crawlJobs, setCrawlJobs] = useState<WebsiteCrawlJobSummary[]>([])
  const [dismissedCrawlJobIds, setDismissedCrawlJobIds] = useState<Set<string>>(new Set())
  const [dismissingCrawlJobIds, setDismissingCrawlJobIds] = useState<Set<string>>(new Set())
  const [recentlyDeletedJobIds, setRecentlyDeletedJobIds] = useState<Set<string>>(new Set())
  const [crawlPresentationWorkspaceId, setCrawlPresentationWorkspaceId] = useState(workspaceId)
  const effectiveCrawlJobs = effectiveCrawlPresentation(crawlPresentationWorkspaceId, workspaceId, crawlJobs)
  const documentPolicyKey = dashboardQueryKeys.documents.list(workspaceId, {
    sourceId: sourceFilterId,
    page: currentPage,
    pageSize: PAGE_SIZE,
  })
  const crawlPolicyKey = dashboardQueryKeys.documents.crawlActivity(workspaceId, {
    recentSinceMinutes: DOCUMENT_CRAWL_RECENT_SINCE_MINUTES,
  })

  const documentQuery = useDocumentListQuery({
    workspaceId, sourceId: sourceFilterId, page: currentPage, pageSize: PAGE_SIZE,
    enabled: queriesEnabled,
    intervalMs: intervalFor(documentPolicyKey),
  })
  const documentQueryKey = documentQuery.queryKey
  const documents = documentQuery.data?.documents ?? EMPTY_DOCUMENTS
  const totalDocuments = documentQuery.data?.total ?? 0
  const hasNextPage = documentQuery.data?.hasMore ?? false
  const hasLoadedDocuments = Boolean(documentQuery.data)
  const isLoading = isInitialDocumentListLoading(documentQuery)
  const patchCurrentDocuments = useCallback((patch: (document: DocumentSummary) => DocumentSummary) => {
    patchDocumentListRow(queryClient, documentQueryKey, patch)
  }, [documentQueryKey, queryClient])
  const crawlQuery = useDocumentCrawlActivityQuery({
    workspaceId,
    enabled: queriesEnabled && onboarding.websiteCrawlerEnabled,
    floorMs: intervalFor(crawlPolicyKey),
    optimisticJobs: effectiveCrawlJobs,
  })

  const totalPages = Math.max(1, Math.ceil(totalDocuments / PAGE_SIZE))

  useEffect(() => {
    recentlyDeletedRef.current = recentlyDeletedJobIds
  }, [recentlyDeletedJobIds])

  useEffect(() => {
    if (!crawlQuery.data || crawlPresentationWorkspaceId !== workspaceId) return
    setCrawlJobs((current) => {
      const merged = mergeCrawlJobs({
        current,
        incoming: crawlQuery.data,
        previousStatuses: previousCrawlJobsRef.current,
        recentlyDeletedJobIds: recentlyDeletedRef.current,
      })
      previousCrawlJobsRef.current = merged.nextStatuses
      if (merged.deletedJobIdsToForget.length > 0) {
        setRecentlyDeletedJobIds((previous) => {
          const next = new Set(previous)
          for (const id of merged.deletedJobIdsToForget) next.delete(id)
          return next
        })
      }
      if (merged.completedJobIds.length > 0) {
        invalidateDashboardQueries(['document.status_changed'])
      }
      return merged.jobs
    })
  }, [crawlPresentationWorkspaceId, crawlQuery.data, invalidateDashboardQueries, workspaceId])

  const websiteCrawlerEnabled = onboarding.websiteCrawlerEnabled

  useEffect(() => {
    let cancelled = false
    void documentsApi
      .listSources()
      .then((response) => {
        if (!cancelled) {
          setAvailableSources(response.sources)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [routeState.workspaceId])

  useEffect(() => {
    setCrawlPresentationWorkspaceId(workspaceId)
    setCrawlJobs([])
    setDismissedCrawlJobIds(new Set())
    setDismissingCrawlJobIds(new Set())
    setRecentlyDeletedJobIds(new Set())
    previousCrawlJobsRef.current = new Map()
    recentlyDeletedRef.current = new Set()
    if (!websiteCrawlerEnabled) {
      return
    }
  }, [websiteCrawlerEnabled, workspaceId])

  useEffect(() => {
    setCurrentPage(routeState.documentsPage ?? 1)
  }, [routeState.documentsPage])

  const visibleCrawlJobs = useMemo(
    () => effectiveCrawlJobs.filter((job) => !dismissedCrawlJobIds.has(job.id)),
    [effectiveCrawlJobs, dismissedCrawlJobIds],
  )

  useEffect(() => {
    const nextPage = getSafeDocumentsPage({
      currentPage,
      totalDocuments,
      pageSize: PAGE_SIZE,
      hasLoadedDocuments,
    })

    if (nextPage === currentPage) {
      return
    }

    setCurrentPage(nextPage)
    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'knowledge',
      documentsPage: nextPage,
    }))
  }, [accountId, currentPage, hasLoadedDocuments, routeState, router, totalDocuments])

  const setDocumentsPage = useCallback((page: number) => {
    setCurrentPage(page)
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'knowledge',
      documentsPage: page,
    }))
  }, [accountId, routeState, router])

  const setSourceFilter = useCallback((sourceId: string | null) => {
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'knowledge',
      knowledgeTab: 'documents',
      documentSourceFilter: sourceId ?? undefined,
      documentsPage: undefined,
    }))
  }, [accountId, routeState, router])

  const resetDetailState = useCallback(() => {
    setEditingDocumentId(null)
    setActiveDocument(null)
    setIsEditingDetail(false)
    setIsMetadataSheetOpen(false)
    setMetadataError(null)
    setSaveError(null)
    setIsDocumentLoading(false)
    setFormValues(EMPTY_FORM)
  }, [])

  const resetCreateDialog = useCallback(() => {
    setEditingDocumentId(null)
    setMetadataError(null)
    setSaveError(null)
    setFormValues(EMPTY_FORM)
    setCreateEnrichmentChoice('inherit')
    setIsSaving(false)
  }, [])

  const resetImportDialog = useCallback(() => {
    setImportTitle('')
    setImportFile(null)
    setImportMetadata({})
    setIsImportMetadataValid(true)
    setImportEnrichmentChoice('inherit')
    setImportError(null)
  }, [])

  // The editor reports its own row-level problems; this only mirrors them into a
  // save gate so an invalid tag cannot be silently dropped by a submit.
  const handleMetadataValidityChange = useCallback((isValid: boolean) => {
    setMetadataError(isValid ? null : INVALID_METADATA_MESSAGE)
  }, [])

  const resetCrawlDialog = useCallback(() => {
    setCrawlUrl('')
    setCrawlLimit('')
    setCrawlIncludeUrlPatterns('')
    setCrawlExcludeUrlPatterns('')
    setCrawlPreserveContentLinks(true)
    setCrawlError(null)
  }, [])

  const openCreateDialog = useCallback(() => {
    justClosedDocumentIdRef.current = null
    resetCreateDialog()
    setIsCreateDialogOpen(true)
  }, [resetCreateDialog])

  const openImportDialog = useCallback(() => {
    resetImportDialog()
    setIsImportDialogOpen(true)
  }, [resetImportDialog])

  const openCrawlDialog = useCallback(() => {
    resetCrawlDialog()
    setIsCrawlDialogOpen(true)
  }, [resetCrawlDialog])

  const handleAddSelect = useCallback((action: AddDocumentAction) => {
    switch (action) {
      case 'crawl':
        openCrawlDialog()
        break
      case 'import':
        openImportDialog()
        break
      case 'create':
        openCreateDialog()
        break
      case 'wordpress':
        setActiveConnectorId('wordpress')
        break
    }
  }, [openCrawlDialog, openImportDialog, openCreateDialog])

  const handleRetryCrawl = useCallback((job: WebsiteCrawlJobSummary) => {
    resetCrawlDialog()
    setCrawlUrl(job.requestedUrl)
    setIsCrawlDialogOpen(true)
  }, [resetCrawlDialog])

  useEffect(() => {
    if (!autoOpenAdd) {
      return
    }
    // Crawling is gated per workspace; skip the open but still clear the flag.
    if (!(autoOpenAdd === 'crawl' && !websiteCrawlerEnabled)) {
      handleAddSelect(autoOpenAdd)
    }
    onAutoOpenAddHandled?.()
  }, [autoOpenAdd, websiteCrawlerEnabled, handleAddSelect, onAutoOpenAddHandled])

  const openDocumentPage = useCallback(async (documentId: string) => {
    justClosedDocumentIdRef.current = null
    setEditingDocumentId(documentId)
    setIsDocumentLoading(true)

    try {
      const [document, sourcesResponse] = await Promise.all([
        documentsApi.getDocument(documentId),
        documentsApi.listSources().catch(() => null),
      ])
      setActiveDocument(document)
      setFormValues({
        title: document.title,
        content: document.content,
        metadata: toEditableMetadata(document.metadata),
        sourceId: document.sourceId ?? MANUALLY_ADDED_SOURCE_ID,
      })
      if (sourcesResponse) {
        setAvailableSources(sourcesResponse.sources)
      }
      setIsEditingDetail(false)
      setMetadataError(null)
      setMetadataSaveError(null)
      setRetrievalError(null)
    } catch (error) {
      console.error('Failed to load document:', error)
      onSelectedDocumentChange?.(null)
      resetDetailState()
    } finally {
      setIsDocumentLoading(false)
    }
  }, [onSelectedDocumentChange, resetDetailState])

  useEffect(() => {
    const hasActiveAudiencePulseDraft =
      audiencePulseDraftSeedRef.current.seed !== null && !audiencePulseDraftSeedRef.current.dismissed
    if (!selectedDocumentId) {
      justClosedDocumentIdRef.current = null
      if (!isSaving && !hasActiveAudiencePulseDraft) {
        resetDetailState()
      }
      return
    }

    if (justClosedDocumentIdRef.current === selectedDocumentId && !isDocumentLoading) {
      return
    }

    if (editingDocumentId === selectedDocumentId && activeDocument) {
      return
    }

    void openDocumentPage(selectedDocumentId)
  }, [
    activeDocument,
    editingDocumentId,
    isDocumentLoading,
    isSaving,
    openDocumentPage,
    resetDetailState,
    selectedDocumentId,
  ])

  // Audience Pulse Start-draft handoff. Runs after the selectedDocumentId effect
  // so its resetDetailState() call cannot clobber the seeded form values on the
  // same mount. The cached seed deliberately survives React StrictMode's effect
  // replay and the route replacement that removes the transient marker;
  // cancelling or saving marks the handoff dismissed and clears it so a later
  // selectedDocumentId change cannot reopen a stale recommendation.
  // `consumeAudiencePulseDraftSeed` clears mismatched entries too, so a
  // cross-workspace seed cannot leak.
  useEffect(() => {
    const workspaceId = routeState.workspaceId
    if (!workspaceId) return
    if (routeState.anchor !== 'audience-pulse-draft') return
    if (selectedDocumentId) return
    if (audiencePulseDraftSeedRef.current.dismissed) return
    if (!audiencePulseDraftSeedRef.current.consumed) {
      audiencePulseDraftSeedRef.current = {
        seed: consumeAudiencePulseDraftSeed({ accountId, workspaceId }),
        consumed: true,
        dismissed: false,
      }
    }
    const seed = audiencePulseDraftSeedRef.current.seed
    if (!seed) {
      router.replace(buildDashboardHref(accountId, {
        ...routeState,
        anchor: undefined,
      }))
      return
    }
    justClosedDocumentIdRef.current = null
    setEditingDocumentId(null)
    setMetadataError(null)
    setSaveError(null)
    setFormValues({
      title: seed.title,
      content: formatDraftQuestionsAsMarkdown(seed.questions),
      metadata: {},
      sourceId: MANUALLY_ADDED_SOURCE_ID,
    })
    setCreateEnrichmentChoice('inherit')
    setIsCreateDialogOpen(true)
    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      anchor: undefined,
    }))
  }, [accountId, routeState, router, selectedDocumentId])

  const handleCreateDialogChange = (open: boolean) => {
    setIsCreateDialogOpen(open)
    if (!open && !isSaving) {
      audiencePulseDraftSeedRef.current = { seed: null, consumed: true, dismissed: true }
      if (routeState.anchor === 'audience-pulse-draft') {
        router.replace(buildDashboardHref(accountId, {
          ...routeState,
          anchor: undefined,
        }))
      }
      resetCreateDialog()
    }
  }

  const handleImportDialogChange = (open: boolean) => {
    setIsImportDialogOpen(open)
    if (!open && !isImporting) {
      resetImportDialog()
    }
  }

  const handleCrawlDialogChange = (open: boolean) => {
    setIsCrawlDialogOpen(open)
    if (!open && !isCrawling) {
      resetCrawlDialog()
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!formValues.title.trim() || !formValues.content.trim()) return

    if (metadataError) return

    const metadata = formValues.metadata

    setSaveError(null)
    setIsSaving(true)

    try {
      const originalSourceId = activeDocument?.sourceId ?? MANUALLY_ADDED_SOURCE_ID
      const sourceChanged = Boolean(editingDocumentId) && formValues.sourceId !== originalSourceId
      const payload = {
        title: formValues.title.trim(),
        content: formValues.content.trim(),
        // Updates always carry metadata so removing the last tag persists as
        // {}; the backend preserves stored metadata when the field is absent.
        ...(editingDocumentId || Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(sourceChanged ? { source: { id: formValues.sourceId } } : {}),
        ...(!editingDocumentId && createEnrichmentChoice !== 'inherit'
          ? { documentEnrichmentOverride: createEnrichmentChoice }
          : {}),
      }

      if (editingDocumentId) {
        await documentsApi.updateDocument(editingDocumentId, payload)
        invalidateDashboardQueries(['document.status_changed'])
        await openDocumentPage(editingDocumentId)
        setIsEditingDetail(false)
      } else {
        await documentsApi.createDocument(payload)
        invalidateDashboardQueries(['document.status_changed'])
        setDocumentsPage(1)
        audiencePulseDraftSeedRef.current = { seed: null, consumed: true, dismissed: true }
        setIsCreateDialogOpen(false)
        resetCreateDialog()
      }
    } catch (error) {
      console.error(`Failed to ${editingDocumentId ? 'update' : 'create'} document:`, error)
      setSaveError(
        getApiErrorMessage(
          error,
          `Failed to ${editingDocumentId ? 'update' : 'save'} document. Please try again.`,
        ),
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleImportSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!importFile) {
      setImportError('Choose a supported file to import.')
      return
    }
    if (!isImportMetadataValid) return

    setImportError(null)
    setIsImporting(true)

    try {
      await documentsApi.importDocument(importFile, importTitle, {
        ...(importEnrichmentChoice !== 'inherit' ? { documentEnrichmentOverride: importEnrichmentChoice } : {}),
        metadata: importMetadata,
      })
      invalidateDashboardQueries(['document.status_changed'])
      setDocumentsPage(1)
      setIsImportDialogOpen(false)
      resetImportDialog()
    } catch (error) {
      setImportError(getApiErrorMessage(error, 'Failed to import document. Please try again.'))
    } finally {
      setIsImporting(false)
    }
  }

  const handleCrawlSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = parseCrawlForm({
      url: crawlUrl,
      limit: crawlLimit,
      includeUrlPatterns: crawlIncludeUrlPatterns,
      excludeUrlPatterns: crawlExcludeUrlPatterns,
      preserveContentLinks: crawlPreserveContentLinks,
      maxLimit: CRAWL_MAX_LIMIT,
    })
    if (!parsed.ok) {
      setCrawlError(parsed.error)
      return
    }

    setCrawlError(null)
    setIsCrawling(true)

    try {
      const response = await documentsApi.crawlWebsite({
        url: parsed.url,
        limit: parsed.limit,
        includeUrlPatterns: parsed.includeUrlPatterns,
        excludeUrlPatterns: parsed.excludeUrlPatterns,
        preserveContentLinks: parsed.preserveContentLinks,
      })
      const optimisticJob: WebsiteCrawlJobSummary = {
        id: response.jobId,
        requestedUrl: response.requestedUrl,
        status: 'queued',
        limit: parsed.limit ?? CRAWL_MAX_LIMIT,
        sourceId: response.sourceId,
        documentCount: null,
        failedPageCount: null,
        skippedPageCount: null,
        failures: [],
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      }
      setCrawlJobs((current) => {
        if (current.some((job) => job.id === optimisticJob.id)) {
          return current
        }
        return [optimisticJob, ...current]
      })
      setDismissedCrawlJobIds((current) => {
        if (!current.has(optimisticJob.id)) {
          return current
        }
        const next = new Set(current)
        next.delete(optimisticJob.id)
        return next
      })
      setIsCrawlDialogOpen(false)
      resetCrawlDialog()
      invalidateDashboardQueries(['crawl.status_changed'])
    } catch (error) {
      setCrawlError(getApiErrorMessage(error, 'Failed to start crawl. Please try again.'))
    } finally {
      setIsCrawling(false)
    }
  }

  const dismissCrawlJob = useCallback(async (job: WebsiteCrawlJobSummary) => {
    const isTerminal = job.status === 'completed' || job.status === 'failed'
    if (!isTerminal) {
      setDismissedCrawlJobIds((current) => {
        if (current.has(job.id)) {
          return current
        }
        const next = new Set(current)
        next.add(job.id)
        return next
      })
      return
    }

    setDismissingCrawlJobIds((current) => {
      if (current.has(job.id)) {
        return current
      }
      const next = new Set(current)
      next.add(job.id)
      return next
    })

    try {
      await documentsApi.deleteCrawlJob(job.id)
      invalidateDashboardQueries(['crawl.status_changed'])
      setCrawlJobs((current) => current.filter((entry) => entry.id !== job.id))
      previousCrawlJobsRef.current.delete(job.id)
      // Track the id so a poll already in flight when DELETE landed cannot
      // reinsert the row before the server reflects the deletion.
      setRecentlyDeletedJobIds((prev) => {
        if (prev.has(job.id)) {
          return prev
        }
        const next = new Set(prev)
        next.add(job.id)
        return next
      })
    } catch (error) {
      console.error('Failed to delete crawl job:', {
        message: getApiErrorMessage(error, 'Failed to delete crawl job.'),
        error,
        jobId: job.id,
      })
    } finally {
      setDismissingCrawlJobIds((current) => {
        if (!current.has(job.id)) {
          return current
        }
        const next = new Set(current)
        next.delete(job.id)
        return next
      })
    }
  }, [invalidateDashboardQueries])

  const handleDeleteDialogChange = (open: boolean) => {
    if (!open && deletingDocumentId) {
      return
    }

    if (!open) {
      setDeleteCandidate(null)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteCandidate) {
      return
    }

    const deletingId = deleteCandidate.id
    setDeletingDocumentId(deletingId)
    setDeleteErrorById((current) => {
      const next = { ...current }
      delete next[deletingId]
      return next
    })

    try {
      await documentsApi.deleteDocument(deletingId)
      invalidateDashboardQueries(['document.status_changed'])
      removeDocumentListRow(queryClient, documentQueryKey, deletingId)
      const nextTotalDocuments = Math.max(0, totalDocuments - 1)
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalDocuments / PAGE_SIZE))
      const nextPage = Math.min(currentPage, nextTotalPages)
      setDocumentsPage(nextPage)
      if (selectedDocumentId === deletingId) {
        onSelectedDocumentChange?.(null)
      }
      setDeleteCandidate(null)
    } catch (error) {
      setDeleteErrorById((current) => ({
        ...current,
        [deletingId]: getApiErrorMessage(error, 'Failed to delete document. Please try again.'),
      }))
    } finally {
      setDeletingDocumentId(null)
    }
  }

  const handleRunMetadataExtraction = async (documentId: string) => {
    setExtractingDocumentId(documentId)
    setRetryErrorById((current) => {
      const next = { ...current }
      delete next[documentId]
      return next
    })
    try {
      await documentsApi.reprocessDocument(documentId, { documentEnrichmentOverride: 'on' })
      invalidateDashboardQueries(['document.status_changed'])
      await openDocumentPage(documentId)
    } catch (error) {
      setRetryErrorById((current) => ({
        ...current,
        [documentId]: getApiErrorMessage(error, 'Failed to run metadata extraction. Please try again.'),
      }))
    } finally {
      setExtractingDocumentId(null)
    }
  }

  const handleRetry = async (documentId: string) => {
    setRetryingDocumentId(documentId)
    setRetryErrorById((current) => {
      const next = { ...current }
      delete next[documentId]
      return next
    })

    try {
      await documentsApi.reprocessDocument(documentId)
      invalidateDashboardQueries(['document.status_changed'])
      if (editingDocumentId === documentId) {
        await openDocumentPage(documentId)
      }
    } catch (error) {
      setRetryErrorById((current) => ({
        ...current,
        [documentId]: getApiErrorMessage(error, 'Failed to retry document processing. Please try again.'),
      }))
    } finally {
      setRetryingDocumentId(null)
    }
  }

  // Imported files keep read-only contents, so their tags cannot ride along on a
  // document save. They go out on their own full-replace PATCH instead.
  const handleSaveDocumentMetadata = async (documentId: string) => {
    if (metadataError) return
    setIsSavingMetadata(true)
    setMetadataSaveError(null)
    try {
      const updated = await documentsApi.updateDocumentMetadata(documentId, formValues.metadata)
      setActiveDocument((current) => (current && current.id === documentId ? updated : current))
      patchCurrentDocuments((document) => document.id === documentId
        ? { ...document, metadata: updated.metadata, updatedAt: updated.updatedAt }
        : document)
      invalidateDashboardQueries(['document.status_changed'])
      setFormValues((current) => ({ ...current, metadata: toEditableMetadata(updated.metadata) }))
    } catch (error) {
      setMetadataSaveError(getApiErrorMessage(error, 'Failed to save metadata. Please try again.'))
    } finally {
      setIsSavingMetadata(false)
    }
  }

  const handleRetrievalUpdate = async (
    documentId: string,
    patch: { retrievalEnabled?: boolean; retrievalExpiresAt?: string | null },
  ) => {
    setIsUpdatingRetrieval(true)
    setRetrievalError(null)
    try {
      const updated = await documentsApi.updateDocumentRetrieval(documentId, patch)
      // Keep the open document and the list row in sync so the toggle, expiry,
      // and status badge reflect the new eligibility immediately.
      setActiveDocument((current) => (current && current.id === documentId ? updated : current))
      patchCurrentDocuments((document) => document.id === documentId
        ? {
            ...document,
            retrievalEnabled: updated.retrievalEnabled,
            retrievalExpiresAt: updated.retrievalExpiresAt,
            updatedAt: updated.updatedAt,
          }
        : document)
      invalidateDashboardQueries(['document.status_changed'])
    } catch (error) {
      setRetrievalError(getApiErrorMessage(error, 'Failed to update retrieval settings. Please try again.'))
    } finally {
      setIsUpdatingRetrieval(false)
    }
  }

  const formatDate = (date: string) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(date))
  }

  const activeDeleteError = deleteCandidate ? deleteErrorById[deleteCandidate.id] : null

  const activeDetailDocument = useMemo(() => {
    if (activeDocument) {
      return activeDocument
    }

    if (!editingDocumentId) {
      return null
    }

    return documents.find((document) => document.id === editingDocumentId) ?? null
  }, [activeDocument, documents, editingDocumentId])

  const goToPreviousPage = () => {
    setDocumentsPage(Math.max(1, currentPage - 1))
  }

  const goToNextPage = () => {
    if (!hasNextPage) {
      return
    }

    setDocumentsPage(Math.min(totalPages, currentPage + 1))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DocumentEditorDialog
        open={isCreateDialogOpen}
        mode="create"
        values={formValues}
        enrichmentChoice={createEnrichmentChoice}
        onEnrichmentChoiceChange={setCreateEnrichmentChoice}
        metadataError={metadataError}
        saveError={saveError}
        isSaving={isSaving}
        isLoading={false}
        onOpenChange={handleCreateDialogChange}
        onChange={(field, value) => {
          setFormValues((current) => ({ ...current, [field]: value }))
          setSaveError(null)
        }}
        onMetadataChange={(value) => {
          setFormValues((current) => ({ ...current, metadata: value }))
          setSaveError(null)
        }}
        onMetadataValidityChange={handleMetadataValidityChange}
        onSubmit={handleSubmit}
      />

      <DocumentImportDialog
        open={isImportDialogOpen}
        importTitle={importTitle}
        enrichmentChoice={importEnrichmentChoice}
        onEnrichmentChoiceChange={setImportEnrichmentChoice}
        importError={importError}
        isImporting={isImporting}
        supportedExtensions={SUPPORTED_IMPORT_EXTENSIONS}
        hasFile={Boolean(importFile)}
        metadata={importMetadata}
        isMetadataValid={isImportMetadataValid}
        onMetadataChange={(value) => {
          setImportMetadata(value)
          setImportError(null)
        }}
        onMetadataValidityChange={setIsImportMetadataValid}
        onOpenChange={handleImportDialogChange}
        onSubmit={handleImportSubmit}
        onTitleChange={(value) => {
          setImportTitle(value)
          setImportError(null)
        }}
        onFileChange={(file) => {
          setImportFile(file)
          setImportError(null)
        }}
      />

      {websiteCrawlerEnabled ? (
        <DocumentCrawlDialog
          open={isCrawlDialogOpen}
          url={crawlUrl}
          limit={crawlLimit}
          includeUrlPatterns={crawlIncludeUrlPatterns}
          excludeUrlPatterns={crawlExcludeUrlPatterns}
          preserveContentLinks={crawlPreserveContentLinks}
          crawlError={crawlError}
          isCrawling={isCrawling}
          maxLimit={CRAWL_MAX_LIMIT}
          onOpenChange={handleCrawlDialogChange}
          onSubmit={handleCrawlSubmit}
          onUrlChange={(value) => {
            setCrawlUrl(value)
            setCrawlError(null)
          }}
          onLimitChange={(value) => {
            setCrawlLimit(value)
            setCrawlError(null)
          }}
          onIncludeUrlPatternsChange={(value) => {
            setCrawlIncludeUrlPatterns(value)
            setCrawlError(null)
          }}
          onExcludeUrlPatternsChange={(value) => {
            setCrawlExcludeUrlPatterns(value)
            setCrawlError(null)
          }}
          onPreserveContentLinksChange={(value) => {
            setCrawlPreserveContentLinks(value)
            setCrawlError(null)
          }}
        />
      ) : null}

      <DocumentDeleteDialog
        candidate={deleteCandidate}
        deletingDocumentId={deletingDocumentId}
        error={activeDeleteError}
        onOpenChange={handleDeleteDialogChange}
        onConfirm={() => void handleConfirmDelete()}
      />

      <FilterDialog
        open={isFilterDialogOpen}
        onOpenChange={setIsFilterDialogOpen}
        filters={documentFilters}
        values={filterValues}
        title="Filter documents"
        description="Narrow the document list. More filters will be added here over time."
        onApply={(next) => {
          const sourceValue = next.source
          const nextSourceId =
            sourceValue?.kind === 'single-select' ? sourceValue.value : null
          setSourceFilter(nextSourceId)
        }}
      />

      {activeConnectorId ? (
        <ConnectorSetupDialog
          open
          connectorId={activeConnectorId}
          onOpenChange={(next) => {
            if (!next) {
              setActiveConnectorId(null)
            }
          }}
        />
      ) : null}

      {selectedDocumentId ? (
        <DocumentEditorPage
          document={activeDetailDocument}
          values={formValues}
          metadataError={metadataError}
          saveError={saveError}
          isLoading={isDocumentLoading}
          isSaving={isSaving}
          isDeleting={activeDetailDocument ? deletingDocumentId === activeDetailDocument.id : false}
          isRetrying={activeDetailDocument ? retryingDocumentId === activeDetailDocument.id : false}
          isEditing={isEditingDetail}
          isMetadataOpen={isMetadataSheetOpen}
          retryError={activeDetailDocument ? retryErrorById[activeDetailDocument.id] : undefined}
          onRunMetadataExtraction={activeDetailDocument ? () => void handleRunMetadataExtraction(activeDetailDocument.id) : undefined}
          isRunningMetadataExtraction={activeDetailDocument ? extractingDocumentId === activeDetailDocument.id : false}
          availableSources={availableSources}
          sourceFilterHref={activeDetailDocument?.sourceId
            ? buildDashboardHref(accountId, {
                ...routeState,
                section: 'knowledge',
                knowledgeTab: 'documents',
                documentId: undefined,
                documentSourceFilter: activeDetailDocument.sourceId,
                documentsPage: undefined,
              })
            : undefined}
          onBack={() => {
            justClosedDocumentIdRef.current = editingDocumentId
            onSelectedDocumentChange?.(null)
          }}
          onChange={(field, value) => {
            setFormValues((current) => ({ ...current, [field]: value }))
            setSaveError(null)
          }}
          onMetadataChange={(value) => {
            setFormValues((current) => ({ ...current, metadata: value }))
            setMetadataSaveError(null)
            setSaveError(null)
          }}
          onMetadataValidityChange={handleMetadataValidityChange}
          onSaveMetadata={
            activeDetailDocument && activeDetailDocument.sourceKind === 'uploaded_file'
              ? () => void handleSaveDocumentMetadata(activeDetailDocument.id)
              : undefined
          }
          isSavingMetadata={isSavingMetadata}
          metadataSaveError={metadataSaveError}
          onSourceChange={(sourceId) => {
            setFormValues((current) => ({ ...current, sourceId }))
            setSaveError(null)
          }}
          onEditingChange={(editing) => {
            if (!editing && editingDocumentId) {
              void openDocumentPage(editingDocumentId)
              return
            }
            setIsEditingDetail(editing)
          }}
          onMetadataOpenChange={setIsMetadataSheetOpen}
          onDelete={() => {
            if (activeDetailDocument) {
              setDeleteCandidate(activeDetailDocument)
            }
          }}
          onRetry={() => {
            if (activeDetailDocument) {
              void handleRetry(activeDetailDocument.id)
            }
          }}
          onInspectChunks={() => {
            if (activeDetailDocument) {
              setChunkInspectorRequest({
                documentId: activeDetailDocument.id,
                documentTitle: activeDetailDocument.title,
              })
            }
          }}
          onRetrievalEnabledChange={(enabled) => {
            if (activeDetailDocument) {
              void handleRetrievalUpdate(activeDetailDocument.id, { retrievalEnabled: enabled })
            }
          }}
          onRetrievalExpiresAtChange={(expiresAt) => {
            if (activeDetailDocument) {
              void handleRetrievalUpdate(activeDetailDocument.id, { retrievalExpiresAt: expiresAt })
            }
          }}
          isUpdatingRetrieval={isUpdatingRetrieval}
          retrievalError={activeDetailDocument ? retrievalError : null}
          onSubmit={handleSubmit}
        />
      ) : (
        <DashboardPage
          title="Documents"
          description="Manage the shared knowledge available in this workspace."
          headerContent={
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <DocumentSearchBar
                query={documentSearch.query}
                onQueryChange={documentSearch.setQuery}
                onSubmit={() => void documentSearch.runSearch()}
                onClear={documentSearch.clearSearch}
                isSearching={documentSearch.isSearching}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 px-3.5"
                onClick={() => setIsFilterDialogOpen(true)}
              >
                <SlidersHorizontal className="mr-2 h-4 w-4" />
                Filter
                {sourceFilterId ? (
                  <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                    1
                  </span>
                ) : null}
              </Button>
              <AddDocumentMenu
                websiteCrawlerEnabled={websiteCrawlerEnabled}
                onSelect={handleAddSelect}
              />
            </div>
          }
          actions={navigation}
        >
            {documentSearch.activeSearch || documentSearch.searchError ? (
              <DocumentSearchResults
                search={documentSearch.activeSearch}
                error={documentSearch.searchError}
                onOpenDocument={(documentId) => {
                  if (onSelectedDocumentChange) {
                    onSelectedDocumentChange(documentId)
                    return
                  }
                  void openDocumentPage(documentId)
                }}
              />
            ) : (
              <div className="space-y-4">
                {websiteCrawlerEnabled ? (
                  <DocumentCrawlJobsBanner
                    jobs={visibleCrawlJobs}
                    onDismiss={(job) => { void dismissCrawlJob(job) }}
                    onRetry={handleRetryCrawl}
                    dismissingJobIds={dismissingCrawlJobIds}
                  />
                ) : null}
                <ActiveFilterPills
                  filters={documentFilters}
                  values={filterValues}
                  onRemove={(id) => {
                    if (id === 'source') setSourceFilter(null)
                  }}
                />
                <DocumentList
                isLoading={isLoading}
                totalDocuments={totalDocuments}
                documents={documents}
                pageSize={PAGE_SIZE}
                currentPage={currentPage}
                hasNextPage={hasNextPage}
                accountId={accountId}
                routeState={routeState}
                onboarding={onboarding}
                deleteErrorById={deleteErrorById}
                retryErrorById={retryErrorById}
                deletingDocumentId={deletingDocumentId}
                retryingDocumentId={retryingDocumentId}
                formatDate={formatDate}
                onPreviousPage={goToPreviousPage}
                onNextPage={goToNextPage}
                onOpenDocument={(documentId) => {
                  if (onSelectedDocumentChange) {
                    onSelectedDocumentChange(documentId)
                    return
                  }
                  void openDocumentPage(documentId)
                }}
                onOpenImport={openImportDialog}
                onOpenCreate={openCreateDialog}
                onDelete={setDeleteCandidate}
                onRetry={(documentId) => void handleRetry(documentId)}
                />
              </div>
            )}
        </DashboardPage>
      )}
      <ChunkInspectorSheet
        request={chunkInspectorRequest}
        onOpenChange={(open) => {
          if (!open) setChunkInspectorRequest(null)
        }}
      />
    </div>
  )
}
