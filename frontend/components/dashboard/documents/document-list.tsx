'use client'

import { FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { Spinner } from '@/components/ui/spinner'
import { DocumentStatus } from '@/components/dashboard/document-status'
import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import type { DocumentSummary } from '@/lib/api'
import type { WorkspaceOnboardingState } from '@/lib/onboarding'

function DocumentsPagination({
  pageStart,
  pageEnd,
  totalDocuments,
  safeCurrentPage,
  totalPages,
  onPrevious,
  onNext,
}: {
  pageStart: number
  pageEnd: number
  totalDocuments: number
  safeCurrentPage: number
  totalPages: number
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Showing {pageStart + 1}-{pageEnd} of {totalDocuments} documents
      </p>
      <Pagination className="mx-0 w-auto justify-start sm:justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              onClick={(event) => {
                event.preventDefault()
                onPrevious()
              }}
              aria-disabled={safeCurrentPage === 1}
              className={safeCurrentPage === 1 ? 'pointer-events-none opacity-50' : undefined}
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
                onNext()
              }}
              aria-disabled={safeCurrentPage === totalPages}
              className={safeCurrentPage === totalPages ? 'pointer-events-none opacity-50' : undefined}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}

function DocumentCard({
  document,
  deletingDocumentId,
  retryingDocumentId,
  deleteError,
  retryError,
  onOpen,
  onDelete,
  onRetry,
  formatDate,
}: {
  document: DocumentSummary
  deletingDocumentId: string | null
  retryingDocumentId: string | null
  deleteError?: string
  retryError?: string
  onOpen: (documentId: string) => void
  onDelete: (document: DocumentSummary) => void
  onRetry: (documentId: string) => void
  formatDate: (date: string) => string
}) {
  const isFailed = document.status.toLowerCase() === 'failed'
  const isImported = document.sourceKind === 'uploaded_file'

  return (
    <div className="grid w-full gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/20 sm:grid-cols-[minmax(0,1fr)_auto]">
      <button type="button" onClick={() => onOpen(document.id)} className="flex min-w-0 items-start gap-4 text-left">
        <div className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-muted">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{document.title}</h3>
            {isImported ? null : <Pencil className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Updated {formatDate(document.updatedAt)}</p>
          {isImported && document.sourceFilename ? (
            <p className="mt-1 text-xs text-muted-foreground">Imported from {document.sourceFilename}</p>
          ) : null}
          <MetadataBadges metadata={document.metadata} />
        </div>
      </button>
      <div className="flex items-center gap-2">
        <DocumentStatus status={document.status} />
        {isFailed ? (
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
            onClick={() => onRetry(document.id)}
            disabled={retryingDocumentId === document.id}
          >
            {retryingDocumentId === document.id ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-full border border-border px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          onClick={() => onDelete(document)}
          disabled={deletingDocumentId === document.id || retryingDocumentId === document.id}
        >
          {deletingDocumentId === document.id ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
        {deleteError ? <p className="max-w-56 text-xs text-destructive">{deleteError}</p> : null}
        {retryError ? <p className="max-w-56 text-xs text-destructive sm:text-right">{retryError}</p> : null}
      </div>
    </div>
  )
}

export function DocumentList({
  isLoading,
  totalDocuments,
  documents,
  pageSize,
  currentPage,
  onboarding,
  deleteErrorById,
  retryErrorById,
  deletingDocumentId,
  retryingDocumentId,
  formatDate,
  onPreviousPage,
  onNextPage,
  onOpenDocument,
  onOpenImport,
  onOpenCreate,
  onDelete,
  onRetry,
}: {
  isLoading: boolean
  totalDocuments: number
  documents: DocumentSummary[]
  pageSize: number
  currentPage: number
  onboarding: WorkspaceOnboardingState
  deleteErrorById: Record<string, string>
  retryErrorById: Record<string, string>
  deletingDocumentId: string | null
  retryingDocumentId: string | null
  formatDate: (date: string) => string
  onPreviousPage: () => void
  onNextPage: () => void
  onOpenDocument: (documentId: string) => void
  onOpenImport: () => void
  onOpenCreate: () => void
  onDelete: (document: DocumentSummary) => void
  onRetry: (documentId: string) => void
}) {
  const totalPages = Math.max(1, Math.ceil(totalDocuments / pageSize))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const pageStart = totalDocuments === 0 ? 0 : (safeCurrentPage - 1) * pageSize
  const pageEnd = Math.min(pageStart + documents.length, totalDocuments)

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (totalDocuments === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <FileText className="h-5 w-5 text-primary" />
        </div>
        <h2 className="mb-1 text-lg font-medium text-foreground">No documents yet</h2>
        <p className="mb-4 max-w-sm text-sm text-muted-foreground">
          {onboarding.isImportingSampleDocs
            ? 'Radioso is seeding this empty workspace with starter documents.'
            : 'Empty workspaces are seeded automatically. You can still import your own files or add inline documents here.'}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onOpenImport}>
            <FileText className="mr-2 h-4 w-4" />
            Import your first file
          </Button>
          <Button size="sm" onClick={onOpenCreate}>
            <Plus className="mr-2 h-4 w-4" />
            Add your first document
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4">
      {totalDocuments > pageSize ? (
        <DocumentsPagination
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalDocuments={totalDocuments}
          safeCurrentPage={safeCurrentPage}
          totalPages={totalPages}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      ) : null}
      <div className="grid w-full gap-3">
        {documents.map((document) => (
          <DocumentCard
            key={document.id}
            document={document}
            deletingDocumentId={deletingDocumentId}
            retryingDocumentId={retryingDocumentId}
            deleteError={deleteErrorById[document.id]}
            retryError={retryErrorById[document.id]}
            onOpen={onOpenDocument}
            onDelete={onDelete}
            onRetry={onRetry}
            formatDate={formatDate}
          />
        ))}
      </div>
      {totalDocuments > pageSize ? (
        <DocumentsPagination
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalDocuments={totalDocuments}
          safeCurrentPage={safeCurrentPage}
          totalPages={totalPages}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      ) : null}
    </div>
  )
}
