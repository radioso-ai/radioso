'use client'

import { FileText, Globe, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DocumentRetrievalBadge, DocumentStatus } from '@/components/dashboard/document-status'
import { getDocumentRetrievalState } from '@/lib/document-retrieval'
import { cn } from '@/lib/utils'
import { DashboardPaginatedContent } from '@/components/dashboard/shared/dashboard-paginated-content'
import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import type { DocumentSummary } from '@/lib/api'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { formatBytes } from '@/lib/format-bytes'
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
        section: 'knowledge',
        documentsPage: Math.max(1, safeCurrentPage - 1),
      })}
      nextHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'knowledge',
        documentsPage: Math.min(totalPages, safeCurrentPage + 1),
      })}
      onPrevious={onPrevious}
      onNext={onNext}
      canPrevious={safeCurrentPage > 1}
      canNext={hasNextPage}
    />
  )
}

function getDocumentSourceLabel(document: DocumentSummary): string {
  if (document.source?.kind === 'website') {
    return document.source.externalId ?? document.source.name ?? '—'
  }
  if (document.sourceKind === 'uploaded_file') {
    return document.sourceFilename ?? document.source?.name ?? '—'
  }
  return document.source?.name ?? 'Manually added'
}

function DocumentRow({
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
  const isWebsite = document.source?.kind === 'website'
  const hasError = Boolean((isFailed && document.failureReason) || deleteError || retryError)
  const sourceLabel = getDocumentSourceLabel(document)
  const retrievalState = getDocumentRetrievalState(document)
  const isDimmed = retrievalState === 'excluded' || retrievalState === 'expired'

  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-12 pr-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/60">
          {isWebsite ? (
            <Globe className="h-4 w-4 text-muted-foreground" />
          ) : (
            <FileText className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </DashboardTableCell>
      <DashboardTableCell>
        <button
          type="button"
          onClick={() => onOpen(document.id)}
          className={cn(
            'block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            isDimmed && 'text-muted-foreground',
          )}
        >
          <span className="block truncate">{document.title}</span>
        </button>
        {hasError ? (
          <div className="mt-1 space-y-0.5">
            {isFailed && document.failureReason ? (
              <p className="truncate text-xs text-destructive">{document.failureReason}</p>
            ) : null}
            {deleteError ? <p className="truncate text-xs text-destructive">{deleteError}</p> : null}
            {retryError ? <p className="truncate text-xs text-destructive">{retryError}</p> : null}
          </div>
        ) : null}
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block truncate">{sourceLabel}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">{sourceLabel}</TooltipContent>
        </Tooltip>
      </DashboardTableCell>
      <DashboardTableCell className="w-24 text-right text-sm tabular-nums text-muted-foreground">
        {typeof document.contentSize === 'number' ? formatBytes(document.contentSize) : '—'}
      </DashboardTableCell>
      <DashboardTableCell className="w-40 text-sm text-muted-foreground">
        {formatDate(document.updatedAt)}
      </DashboardTableCell>
      <DashboardTableCell className="w-44">
        <div className="flex flex-wrap items-center gap-1.5">
          <DocumentStatus status={document.status} />
          <DocumentRetrievalBadge document={document} />
        </div>
      </DashboardTableCell>
      <DashboardTableCell className="w-28">
        <div className="flex items-center justify-end gap-2">
          {isFailed ? (
            <button
              type="button"
              aria-label={`Retry processing ${document.title}`}
              title="Retry processing"
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
            aria-label={`Delete ${document.title}`}
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
      </DashboardTableCell>
    </DashboardTableRow>
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
  const hasRows = documents.length > 0
  const isRefreshingRows = isLoading && hasRows

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
    <DashboardPaginatedContent className="w-full space-y-4" isRefreshing={isRefreshingRows}>
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
      {isLoading && !hasRows ? (
        <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : (
        <DashboardTable aria-label="Documents">
          <DashboardTableHead>
            <DashboardTableHeader className="w-12" />
            <DashboardTableHeader>Name</DashboardTableHeader>
            <DashboardTableHeader className="w-48">Source</DashboardTableHeader>
            <DashboardTableHeader className="w-24 text-right">Size</DashboardTableHeader>
            <DashboardTableHeader className="w-40">Updated</DashboardTableHeader>
            <DashboardTableHeader className="w-44">Status</DashboardTableHeader>
            <DashboardTableHeader className="w-28 text-right" />
          </DashboardTableHead>
          <DashboardTableBody>
          {documents.map((document) => (
            <DocumentRow
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
          </DashboardTableBody>
        </DashboardTable>
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
    </DashboardPaginatedContent>
  )
}
