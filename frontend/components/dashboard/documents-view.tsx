'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { DocumentStatus } from '@/components/dashboard/document-status'
import {
  type DocumentSummary,
  documentsApi,
} from '@/lib/api'

type EditorMode = 'create' | 'edit'
const PAGE_SIZE = 100

interface DocumentsViewProps {
  selectedDocumentId?: string | null
  onSelectedDocumentChange?: (documentId: string | null) => void
}

const EMPTY_FORM = {
  title: '',
  content: '',
}

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function DocumentsView({
  selectedDocumentId = null,
  onSelectedDocumentChange,
}: DocumentsViewProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isDocumentLoading, setIsDocumentLoading] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>('create')
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null)
  const [formValues, setFormValues] = useState(EMPTY_FORM)
  const [deleteCandidate, setDeleteCandidate] = useState<DocumentSummary | null>(null)
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null)
  const [deleteErrorById, setDeleteErrorById] = useState<Record<string, string>>({})
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null)
  const [retryErrorById, setRetryErrorById] = useState<Record<string, string>>({})

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await documentsApi.listDocuments()
      setDocuments(docs)
    } catch (error) {
      console.error('Failed to load documents:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDocuments()
  }, [loadDocuments])

  useEffect(() => {
    const hasActiveProcessing = documents.some((document) => {
      const normalizedStatus = document.status.toLowerCase()
      return normalizedStatus === 'queued' || normalizedStatus === 'processing'
    })

    if (!hasActiveProcessing) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void loadDocuments()
    }, 2000)

    return () => window.clearTimeout(timeoutId)
  }, [documents, loadDocuments])

  useEffect(() => {
    setCurrentPage((page) => {
      const totalPages = Math.max(1, Math.ceil(documents.length / PAGE_SIZE))
      return Math.min(page, totalPages)
    })
  }, [documents.length])

  const resetEditor = useCallback(() => {
    setEditorMode('create')
    setEditingDocumentId(null)
    setFormValues(EMPTY_FORM)
    setIsDocumentLoading(false)
  }, [])

  const openCreateDialog = () => {
    resetEditor()
    setIsDialogOpen(true)
  }

  const openEditDialog = useCallback(async (documentId: string) => {
    setIsDialogOpen(true)
    setEditorMode('edit')
    setEditingDocumentId(documentId)
    setIsDocumentLoading(true)

    try {
      const document = await documentsApi.getDocument(documentId)
      setFormValues({
        title: document.title,
        content: document.content,
      })
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
      if (editorMode === 'edit' && isDialogOpen && !isSaving) {
        setIsDialogOpen(false)
        resetEditor()
      }
      return
    }

    if (
      editorMode === 'edit' &&
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

  const upsertDocument = async (documentId: string) => {
    const nextDocument = await documentsApi.getDocument(documentId)
    setDocuments((currentDocuments) => {
      const withoutCurrent = currentDocuments.filter((document) => document.id !== documentId)
      return [nextDocument, ...withoutCurrent].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
    })
  }

  const handleDialogChange = (open: boolean) => {
    setIsDialogOpen(open)
    if (!open && !isSaving) {
      if (editorMode === 'edit') {
        onSelectedDocumentChange?.(null)
      }
      resetEditor()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formValues.title.trim() || !formValues.content.trim()) return

    setIsSaving(true)

    try {
      const payload = {
        title: formValues.title.trim(),
        content: formValues.content.trim(),
      }
      const response = editingDocumentId
        ? await documentsApi.updateDocument(editingDocumentId, payload)
        : await documentsApi.createDocument(payload)

      await upsertDocument(response.documentId)
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
      setDocuments((currentDocuments) => {
        const nextDocuments = currentDocuments.filter((document) => document.id !== deletingId)
        const nextTotalPages = Math.max(1, Math.ceil(nextDocuments.length / PAGE_SIZE))
        setCurrentPage((page) => Math.min(page, nextTotalPages))
        return nextDocuments
      })
      if (selectedDocumentId === deletingId) {
        onSelectedDocumentChange?.(null)
      }
      setDeleteCandidate(null)
    } catch (error) {
      setDeleteErrorById((current) => ({
        ...current,
        [deletingId]: getErrorMessage(error, 'Failed to delete document. Please try again.'),
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
      const response = await documentsApi.reprocessDocument(documentId)
      await upsertDocument(response.documentId)
    } catch (error) {
      setRetryErrorById((current) => ({
        ...current,
        [documentId]: getErrorMessage(error, 'Failed to retry document processing. Please try again.'),
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

  const renderDialogBody = () => {
    if (isDocumentLoading) {
      return (
        <div className="flex flex-1 min-h-[240px] items-center justify-center">
          <Spinner className="w-6 h-6" />
        </div>
      )
    }

    return (
      <form onSubmit={handleSubmit} className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="space-y-2 flex-shrink-0">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={formValues.title}
              onChange={(e) => setFormValues((current) => ({ ...current, title: e.target.value }))}
              placeholder="Document title"
              disabled={isSaving}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col space-y-2">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              value={formValues.content}
              onChange={(e) => setFormValues((current) => ({ ...current, content: e.target.value }))}
              placeholder="Paste your document content here..."
              className="h-full min-h-[320px] flex-1 resize-none overflow-y-auto [field-sizing:fixed]"
              disabled={isSaving}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-shrink-0 justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleDialogChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSaving || !formValues.title.trim() || !formValues.content.trim()}
          >
            {isSaving ? <Spinner className="mr-2" /> : null}
            {editorMode === 'edit' ? 'Save Document' : 'Add Document'}
          </Button>
        </div>
      </form>
    )
  }

  const totalPages = Math.max(1, Math.ceil(documents.length / PAGE_SIZE))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const pageStart = (safeCurrentPage - 1) * PAGE_SIZE
  const paginatedDocuments = documents.slice(pageStart, pageStart + PAGE_SIZE)
  const pageEnd = Math.min(pageStart + paginatedDocuments.length, documents.length)
  const activeDeleteError = deleteCandidate ? deleteErrorById[deleteCandidate.id] : null

  const goToPreviousPage = () => {
    setCurrentPage((page) => Math.max(1, page - 1))
  }

  const goToNextPage = () => {
    setCurrentPage((page) => Math.min(totalPages, page + 1))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-medium text-foreground">Documents</h1>
          <p className="text-sm text-muted-foreground">Manage your knowledge base</p>
        </div>
        <Button size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add Document
        </Button>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="flex h-[min(85vh,760px)] max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editorMode === 'edit' ? 'Edit Document' : 'Add Document'}</DialogTitle>
            <DialogDescription>
              {editorMode === 'edit'
                ? 'Update the document and re-run it through the RAG ingestion pipeline.'
                : 'Add a new document to your knowledge base for retrieval.'}
            </DialogDescription>
          </DialogHeader>
          {renderDialogBody()}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteCandidate !== null} onOpenChange={handleDeleteDialogChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{' '}
              <span className="font-medium text-foreground">{deleteCandidate?.title ?? 'this document'}</span>{' '}
              from your knowledge base.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {activeDeleteError ? (
            <p className="text-sm text-destructive" role="alert">
              {activeDeleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingDocumentId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmDelete()
              }}
              disabled={Boolean(deletingDocumentId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingDocumentId ? (
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

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <h2 className="mb-1 text-lg font-medium text-foreground">No documents yet</h2>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">
              Add documents to your knowledge base to start asking questions.
            </p>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Add your first document
            </Button>
          </div>
        ) : (
          <div className="w-full space-y-4">
            <div className="grid w-full gap-3">
              {paginatedDocuments.map((doc) => {
                const deleteError = deleteErrorById[doc.id]
                const retryError = retryErrorById[doc.id]
                const isFailed = doc.status.toLowerCase() === 'failed'
                return (
                  <div
                    key={doc.id}
                    className="grid w-full gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/20 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onSelectedDocumentChange
                          ? onSelectedDocumentChange(doc.id)
                          : void openEditDialog(doc.id)
                      }
                      className="flex min-w-0 items-start gap-4 text-left"
                    >
                      <div className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-muted">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <h3 className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                            {doc.title}
                          </h3>
                          <Pencil className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Updated {formatDate(doc.updatedAt)}
                        </p>
                      </div>
                    </button>
                    <div className="flex flex-col items-start gap-2 sm:items-end">
                      <DocumentStatus status={doc.status} />
                      {isFailed ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => void handleRetry(doc.id)}
                          disabled={retryingDocumentId === doc.id}
                        >
                          {retryingDocumentId === doc.id ? (
                            <Spinner className="mr-1 h-3.5 w-3.5" />
                          ) : (
                            <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          )}
                          Retry
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-destructive hover:text-destructive"
                        onClick={() => setDeleteCandidate(doc)}
                        disabled={deletingDocumentId === doc.id || retryingDocumentId === doc.id}
                      >
                        {deletingDocumentId === doc.id ? (
                          <Spinner className="mr-1 h-3.5 w-3.5" />
                        ) : (
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                        )}
                        Delete
                      </Button>
                      {deleteError ? (
                        <p className="max-w-56 text-xs text-destructive sm:text-right">{deleteError}</p>
                      ) : null}
                      {retryError ? (
                        <p className="max-w-56 text-xs text-destructive sm:text-right">{retryError}</p>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
            {documents.length > PAGE_SIZE && (
              <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  Showing {pageStart + 1}-{pageEnd} of {documents.length} documents
                </p>
                <Pagination className="mx-0 w-auto justify-start sm:justify-end">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        onClick={(event) => {
                          event.preventDefault()
                          goToPreviousPage()
                        }}
                        aria-disabled={safeCurrentPage === 1}
                        className={
                          safeCurrentPage === 1
                            ? 'pointer-events-none opacity-50'
                            : undefined
                        }
                      />
                    </PaginationItem>
                    <PaginationItem>
                      <span className="px-3 text-sm text-muted-foreground">
                        Page {safeCurrentPage} of {totalPages}
                      </span>
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        onClick={(event) => {
                          event.preventDefault()
                          goToNextPage()
                        }}
                        aria-disabled={safeCurrentPage === totalPages}
                        className={
                          safeCurrentPage === totalPages
                            ? 'pointer-events-none opacity-50'
                            : undefined
                        }
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
