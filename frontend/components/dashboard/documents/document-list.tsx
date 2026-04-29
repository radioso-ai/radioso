'use client'

import { FileText, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { DocumentStatus } from '@/components/dashboard/document-status'
import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import type { DocumentSummary } from '@/lib/api'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import type { WorkspaceOnboardingState } from '@/lib/onboarding'

function DocumentsPagination({
  accountId,
  routeState,
  pageStart,
  pageEnd,
  totalDocuments,
  safeCurrentPage,
  totalPages,
  hasNextPage,
  onPrevious,
  onNext,
}: {
  accountId: string
  routeState: DashboardRouteState
  pageStart: number
  pageEnd: number
  totalDocuments: number
  safeCurrentPage: number
  totalPages: number
  hasNextPage: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <DashboardPagination
      summary={`${pageStart + 1} to ${pageEnd} of ${totalDocuments}`}
      currentPage={safeCurrentPage}
      totalPages={totalPages}
      previousHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'documents',
        documentsPage: Math.max(1, safeCurrentPage - 1),
      })}
      nextHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'documents',
        documentsPage: Math.min(totalPages, safeCurrentPage + 1),
      })}
      onPrevious={onPrevious}
      onNext={onNext}
      canPrevious={safeCurrentPage > 1}
      canNext={hasNextPage}
    />
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
    <div className="flex w-full flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3.5 transition-colors hover:border-primary/40 hover:bg-accent/20 sm:flex-row sm:items-center">
      <button type="button" onClick={() => onOpen(document.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-muted">
          <FileText className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{document.title}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Updated {formatDate(document.updatedAt)}
            {isImported && document.sourceFilename ? ` - Imported from ${document.sourceFilename}` : ''}
          </p>
          {isFailed && document.failureReason ? (
            <p className="text-xs text-destructive">{document.failureReason}</p>
          ) : null}
          {deleteError ? <p className="text-xs text-destructive">{deleteError}</p> : null}
          {retryError ? <p className="text-xs text-destructive">{retryError}</p> : null}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
        <DocumentStatus status={document.status} />
        {isFailed ? (
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
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
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-destructive hover:bg-destructive/10 disabled:opacity-50"
          onClick={() => onDelete(document)}
          disabled={deletingDocumentId === document.id || retryingDocumentId === document.id}
        >
          {deletingDocumentId === document.id ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
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
  hasNextPage,
  accountId,
  routeState,
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
  hasNextPage: boolean
  accountId: string
  routeState: DashboardRouteState
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
  const pageItemCount = isLoading ? pageSize : documents.length
  const pageEnd = Math.min(pageStart + pageItemCount, totalDocuments)
  const shouldShowPagination = totalDocuments > pageSize

  if (isLoading && totalDocuments === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
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
            : 'Import your own files or add inline documents here. Starter docs are only used during the guided first-run flow.'}
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
      {shouldShowPagination ? (
        <DocumentsPagination
          accountId={accountId}
          routeState={routeState}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalDocuments={totalDocuments}
          safeCurrentPage={safeCurrentPage}
          totalPages={totalPages}
          hasNextPage={hasNextPage}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      ) : null}
      {isLoading ? (
        <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : (
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
      )}
      {shouldShowPagination ? (
        <DocumentsPagination
          accountId={accountId}
          routeState={routeState}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalDocuments={totalDocuments}
          safeCurrentPage={safeCurrentPage}
          totalPages={totalPages}
          hasNextPage={hasNextPage}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      ) : null}
    </div>
  )
}
