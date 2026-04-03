'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { DocumentSearchBar } from '@/components/dashboard/document-search-bar'
import { DocumentSearchResults } from '@/components/dashboard/document-search-results'
import {
  type DocumentSummary,
  documentsApi,
} from '@/lib/api'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useDocumentSearch } from '@/components/dashboard/use-document-search'
import { DocumentDeleteDialog } from '@/components/dashboard/documents/document-delete-dialog'
import { DocumentEditorDialog } from '@/components/dashboard/documents/document-editor-dialog'
import { DocumentImportDialog } from '@/components/dashboard/documents/document-import-dialog'
import { DocumentList } from '@/components/dashboard/documents/document-list'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { getSafeDocumentsPage } from '@/lib/documents-pagination'

type EditorMode = 'create' | 'edit' | 'view'
const PAGE_SIZE = 100

interface DocumentsViewProps {
  routeState: DashboardRouteState
  accountId: string
  selectedDocumentId?: string | null
  onSelectedDocumentChange?: (documentId: string | null) => void
  onboarding: WorkspaceOnboardingState
}

const EMPTY_FORM = {
  title: '',
  content: '',
  metadata: '',
}

const SUPPORTED_IMPORT_EXTENSIONS = '.pdf,.txt,.docx,.xlsx'

interface DocumentPageSnapshot {
  documents: DocumentSummary[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

const parseMetadata = (raw: string): Record<string, string | number | boolean | null> | null => {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function DocumentsView({
  routeState,
  accountId,
  selectedDocumentId = null,
  onSelectedDocumentChange,
  onboarding,
}: DocumentsViewProps) {
  const router = useRouter()
  const justClosedDocumentIdRef = useRef<string | null>(null)
  const documentWorkspaceKeyRef = useRef(`${accountId}:${routeState.workspaceId ?? ''}`)
  const documentCursorByPageRef = useRef(new Map<number, string | null>([[1, null]]))
  const documentPageCacheRef = useRef(new Map<number, DocumentPageSnapshot>())
  const documentSearch = useDocumentSearch()
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [totalDocuments, setTotalDocuments] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [currentPage, setCurrentPage] = useState(routeState.documentsPage ?? 1)
  const [hasLoadedDocuments, setHasLoadedDocuments] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [isDocumentLoading, setIsDocumentLoading] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>('create')
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null)
  const [formValues, setFormValues] = useState(EMPTY_FORM)
  const [importTitle, setImportTitle] = useState('')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<DocumentSummary | null>(null)
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null)
  const [deleteErrorById, setDeleteErrorById] = useState<Record<string, string>>({})
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null)
  const [retryErrorById, setRetryErrorById] = useState<Record<string, string>>({})
  const totalPages = Math.max(1, Math.ceil(totalDocuments / PAGE_SIZE))

  const resetDocumentPagination = useCallback(() => {
    documentCursorByPageRef.current = new Map([[1, null]])
    documentPageCacheRef.current = new Map()
  }, [])

  const loadDocuments = useCallback(async (
    page: number,
    options?: { background?: boolean; reset?: boolean },
  ) => {
    if (!options?.background) {
      setIsLoading(true)
    }

    try {
      if (options?.reset) {
        resetDocumentPagination()
      }

      const cursorByPage = documentCursorByPageRef.current
      const pageCache = documentPageCacheRef.current

      let response = pageCache.get(page)

      if (!response) {
        for (let pageNumber = 1; pageNumber <= page; pageNumber += 1) {
          const cachedPage = pageCache.get(pageNumber)
          if (cachedPage) {
            if (!cursorByPage.has(pageNumber + 1)) {
              cursorByPage.set(pageNumber + 1, cachedPage.nextCursor)
            }
            response = cachedPage
            continue
          }

          const cursor = cursorByPage.get(pageNumber) ?? null
          if (pageNumber > 1 && cursor === null) {
            const previousPage = pageCache.get(pageNumber - 1)
            const emptySnapshot: DocumentPageSnapshot = {
              documents: [],
              total: previousPage?.total ?? 0,
              hasMore: false,
              nextCursor: null,
            }
            pageCache.set(pageNumber, emptySnapshot)
            response = emptySnapshot
            continue
          }

          const nextResponse = await documentsApi.listDocuments({
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          })
          const snapshot: DocumentPageSnapshot = {
            documents: nextResponse.documents,
            total: nextResponse.total,
            hasMore: nextResponse.hasMore,
            nextCursor: nextResponse.nextCursor,
          }
          pageCache.set(pageNumber, snapshot)
          cursorByPage.set(pageNumber + 1, nextResponse.nextCursor)
          response = snapshot
        }
      }

      const pageSnapshot = response ?? {
        documents: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
      }

      setDocuments(pageSnapshot.documents)
      setTotalDocuments(pageSnapshot.total)
      setHasNextPage(pageSnapshot.hasMore)
    } catch (error) {
      console.error('Failed to load documents:', error)
    } finally {
      setHasLoadedDocuments(true)
      if (!options?.background) {
        setIsLoading(false)
      }
    }
  }, [resetDocumentPagination])

  useEffect(() => {
    const nextWorkspaceKey = `${accountId}:${routeState.workspaceId ?? ''}`
    const workspaceChanged = documentWorkspaceKeyRef.current !== nextWorkspaceKey

    if (workspaceChanged) {
      documentWorkspaceKeyRef.current = nextWorkspaceKey
      resetDocumentPagination()
      void loadDocuments(currentPage, { reset: true })
      return
    }

    void loadDocuments(currentPage)
  }, [accountId, currentPage, loadDocuments, resetDocumentPagination, routeState.workspaceId])

  useEffect(() => {
    setCurrentPage(routeState.documentsPage ?? 1)
  }, [routeState.documentsPage])

  useEffect(() => {
    const hasActiveProcessing = documents.some((document) => {
      const normalizedStatus = document.status.toLowerCase()
      return normalizedStatus === 'queued' || normalizedStatus === 'processing'
    })

    if (!hasActiveProcessing) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void loadDocuments(currentPage, { background: true, reset: true })
    }, 2000)

    return () => window.clearTimeout(timeoutId)
  }, [currentPage, documents, loadDocuments])

  useEffect(() => {
    setCurrentPage((page) => {
      const nextPage = getSafeDocumentsPage({
        currentPage: page,
        totalDocuments,
        pageSize: PAGE_SIZE,
        hasLoadedDocuments,
      })
      if (nextPage !== page) {
        router.replace(buildDashboardHref(accountId, {
          ...routeState,
          section: 'documents',
          documentsPage: nextPage,
        }))
      }
      return nextPage
    })
  }, [accountId, hasLoadedDocuments, routeState, router, totalDocuments])

  const setDocumentsPage = useCallback((page: number) => {
    setCurrentPage(page)
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'documents',
      documentsPage: page,
    }))
  }, [accountId, routeState, router])

  const resetEditor = useCallback(() => {
    setEditorMode('create')
    setEditingDocumentId(null)
    setFormValues(EMPTY_FORM)
    setMetadataError(null)
    setIsDocumentLoading(false)
  }, [])

  const openCreateDialog = () => {
    justClosedDocumentIdRef.current = null
    resetEditor()
    setIsDialogOpen(true)
  }

  const resetImportDialog = useCallback(() => {
    setImportTitle('')
    setImportFile(null)
    setImportError(null)
  }, [])

  const openImportDialog = () => {
    resetImportDialog()
    setIsImportDialogOpen(true)
  }

  const openEditDialog = useCallback(async (documentId: string) => {
    justClosedDocumentIdRef.current = null
    setEditingDocumentId(documentId)
    setIsDocumentLoading(true)

    try {
      const document = await documentsApi.getDocument(documentId)
      const metadataStr = Object.keys(document.metadata ?? {}).length > 0
        ? JSON.stringify(document.metadata, null, 2)
        : ''

      setEditorMode(document.sourceKind === 'inline_text' ? 'edit' : 'view')
      setFormValues({
        title: document.title,
        content: document.content,
        metadata: metadataStr,
      })
      setIsDialogOpen(true)
    } catch (error) {
      console.error('Failed to load document:', error)
      setIsDialogOpen(false)
      onSelectedDocumentChange?.(null)
      resetEditor()
    } finally {
      setIsDocumentLoading(false)
    }
  }, [onSelectedDocumentChange, resetEditor])

  useEffect(() => {
    if (!selectedDocumentId) {
      justClosedDocumentIdRef.current = null
      if ((editorMode === 'edit' || editorMode === 'view') && isDialogOpen && !isSaving) {
        setIsDialogOpen(false)
        resetEditor()
      }
      return
    }

    if (justClosedDocumentIdRef.current === selectedDocumentId && !isDialogOpen) {
      return
    }

    if (
      (editorMode === 'edit' || editorMode === 'view') &&
      editingDocumentId === selectedDocumentId &&
      isDialogOpen
    ) {
      return
    }

    void openEditDialog(selectedDocumentId)
  }, [
    editingDocumentId,
    editorMode,
    isDialogOpen,
    isSaving,
    openEditDialog,
    resetEditor,
    selectedDocumentId,
  ])

  const handleDialogChange = (open: boolean) => {
    if (!open && !isSaving) {
      justClosedDocumentIdRef.current = editingDocumentId
      setIsDialogOpen(false)
      if (editorMode === 'edit' || editorMode === 'view') {
        onSelectedDocumentChange?.(null)
      }
      window.setTimeout(() => {
        resetEditor()
      }, 0)
      return
    }

    setIsDialogOpen(open)
  }

  const handleImportDialogChange = (open: boolean) => {
    setIsImportDialogOpen(open)
    if (!open && !isImporting) {
      resetImportDialog()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formValues.title.trim() || !formValues.content.trim()) return

    const metadata = parseMetadata(formValues.metadata)
    if (metadata === null) {
      setMetadataError('Invalid JSON. Must be an object with string, number, boolean, or null values.')
      return
    }

    setMetadataError(null)
    setIsSaving(true)

    try {
      const payload = {
        title: formValues.title.trim(),
        content: formValues.content.trim(),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }
      const response = editingDocumentId
        ? await documentsApi.updateDocument(editingDocumentId, payload)
        : await documentsApi.createDocument(payload)

      void response
      setDocumentsPage(1)
      await loadDocuments(1, { reset: true })
      setIsDialogOpen(false)
      if (editorMode === 'edit') {
        onSelectedDocumentChange?.(null)
      }
      resetEditor()
    } catch (error) {
      console.error(`Failed to ${editingDocumentId ? 'update' : 'create'} document:`, error)
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

    setImportError(null)
    setIsImporting(true)

    try {
      await documentsApi.importDocument(importFile, importTitle)
      setDocumentsPage(1)
      await loadDocuments(1, { reset: true })
      setIsImportDialogOpen(false)
      resetImportDialog()
    } catch (error) {
      setImportError(getApiErrorMessage(error, 'Failed to import document. Please try again.'))
    } finally {
      setIsImporting(false)
    }
  }

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
      const nextTotalDocuments = Math.max(0, totalDocuments - 1)
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalDocuments / PAGE_SIZE))
      const nextPage = Math.min(currentPage, nextTotalPages)
      setDocumentsPage(nextPage)
      await loadDocuments(nextPage, { reset: true })
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

  const handleRetry = async (documentId: string) => {
    setRetryingDocumentId(documentId)
    setRetryErrorById((current) => {
      const next = { ...current }
      delete next[documentId]
      return next
    })

    try {
      await documentsApi.reprocessDocument(documentId)
      await loadDocuments(currentPage, { reset: true })
    } catch (error) {
      setRetryErrorById((current) => ({
        ...current,
        [documentId]: getApiErrorMessage(error, 'Failed to retry document processing. Please try again.'),
      }))
    } finally {
      setRetryingDocumentId(null)
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
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h1 className="text-lg font-medium text-foreground">Documents</h1>
            <p className="text-sm text-muted-foreground">Manage your knowledge base</p>
          </div>
          <DocumentSearchBar
            query={documentSearch.query}
            onQueryChange={documentSearch.setQuery}
            onSubmit={() => void documentSearch.runSearch()}
            onClear={documentSearch.clearSearch}
            isSearching={documentSearch.isSearching}
          />
        </div>
        <div className="flex items-center gap-2 xl:shrink-0">
          <Button size="sm" variant="outline" className="h-11 px-4" onClick={openImportDialog}>
            <FileText className="mr-2 h-4 w-4" />
            Import File
          </Button>
          <Button size="sm" className="h-11 px-4" onClick={openCreateDialog}>
            <Plus className="mr-2 h-4 w-4" />
            Add Document
          </Button>
        </div>
        </div>
      </div>

      <DocumentEditorDialog
        open={isDialogOpen}
        mode={editorMode}
        values={formValues}
        metadataError={metadataError}
        isSaving={isSaving}
        isLoading={isDocumentLoading}
        onOpenChange={handleDialogChange}
        onChange={(field, value) => setFormValues((current) => ({ ...current, [field]: value }))}
        onMetadataChange={(value) => {
          setFormValues((current) => ({ ...current, metadata: value }))
          setMetadataError(null)
        }}
        onSubmit={handleSubmit}
      />

      <DocumentImportDialog
        open={isImportDialogOpen}
        importTitle={importTitle}
        importError={importError}
        isImporting={isImporting}
        supportedExtensions={SUPPORTED_IMPORT_EXTENSIONS}
        hasFile={Boolean(importFile)}
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

      <DocumentDeleteDialog
        candidate={deleteCandidate}
        deletingDocumentId={deletingDocumentId}
        error={activeDeleteError}
        onOpenChange={handleDeleteDialogChange}
        onConfirm={() => void handleConfirmDelete()}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {documentSearch.activeSearch || documentSearch.searchError ? (
          <DocumentSearchResults
            search={documentSearch.activeSearch}
            error={documentSearch.searchError}
            onOpenDocument={(documentId) => {
              if (onSelectedDocumentChange) {
                onSelectedDocumentChange(documentId)
                return
              }
              void openEditDialog(documentId)
            }}
          />
        ) : (
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
              void openEditDialog(documentId)
            }}
            onOpenImport={openImportDialog}
            onOpenCreate={openCreateDialog}
            onDelete={setDeleteCandidate}
            onRetry={(documentId) => void handleRetry(documentId)}
          />
        )}
      </div>
    </div>
  )
}
