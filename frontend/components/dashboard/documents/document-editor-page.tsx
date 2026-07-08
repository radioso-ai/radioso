'use client'

import type { FormEvent } from 'react'
import Link from 'next/link'
import { ArrowLeft, Boxes, ExternalLink, FileText, PanelRight, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react'

import { DocumentStatus } from '@/components/dashboard/document-status'
import { MarkdownContent } from '@/components/markdown/markdown-content'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DocumentSourceListItem, DocumentSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

// Synthetic source created automatically for inline documents that the user
// writes directly in the editor. Documents in this bucket can be reassigned to
// other sources; documents in crawl/upload/connector sources stay locked.
export const MANUALLY_ADDED_SOURCE_ID = '00000000-0000-0000-0000-000000000001'

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export type DocumentEditorValues = {
  title: string
  content: string
  metadata: string
  sourceId: string
}

export function DocumentEditorPage({
  document,
  values,
  metadataError,
  saveError,
  isLoading,
  isSaving,
  isDeleting,
  isRetrying,
  isEditing,
  isMetadataOpen,
  retryError,
  availableSources,
  sourceFilterHref,
  onBack,
  onChange,
  onMetadataChange,
  onSourceChange,
  onEditingChange,
  onMetadataOpenChange,
  onDelete,
  onRetry,
  onRunMetadataExtraction,
  isRunningMetadataExtraction,
  onInspectChunks,
  onSubmit,
}: {
  document: DocumentSummary | null
  values: DocumentEditorValues
  metadataError: string | null
  saveError?: string | null
  isLoading: boolean
  isSaving: boolean
  isDeleting: boolean
  isRetrying: boolean
  isEditing: boolean
  isMetadataOpen: boolean
  retryError?: string
  availableSources: DocumentSourceListItem[]
  sourceFilterHref?: string
  onBack: () => void
  onRunMetadataExtraction?: () => void
  isRunningMetadataExtraction?: boolean
  onChange: (field: keyof DocumentEditorValues, value: string) => void
  onMetadataChange: (value: string) => void
  onSourceChange: (sourceId: string) => void
  onEditingChange: (editing: boolean) => void
  onMetadataOpenChange: (open: boolean) => void
  onDelete: () => void
  onRetry: () => void
  onInspectChunks: () => void
  onSubmit: (event: FormEvent) => void
}) {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!document) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-medium text-foreground">Document unavailable</h2>
          <p className="text-sm text-muted-foreground">The selected document could not be loaded.</p>
        </div>
        <Button variant="outline" onClick={onBack}>
          Back to documents
        </Button>
      </div>
    )
  }

  const isInlineText = document.sourceKind === 'inline_text'
  const isFailed = document.status.toLowerCase() === 'failed'
  const sourceIsManual = (document.sourceId ?? null) === MANUALLY_ADDED_SOURCE_ID
  const isEditable = isInlineText && sourceIsManual
  const canEditSource = isEditing && isEditable
  const currentSourceName =
    availableSources.find((source) => source.id === values.sourceId)?.name ??
    document.source?.name ??
    '—'
  const sourceName = document.source?.name ?? null
  const sourceUrlRaw = document.metadata?.sourceUrl
  const sourceUrl = typeof sourceUrlRaw === 'string' && sourceUrlRaw.trim().length > 0 ? sourceUrlRaw : null
  const enrichment = document.enrichment ?? null
  const enrichmentRows = enrichment
    ? [
        ['Status', enrichment.status],
        ['Enriched', formatDateTime(enrichment.enrichedAt)],
      ].filter(([, value]) => value)
    : []
  const readOnlyExplanation = document.sourceKind === 'uploaded_file'
    ? 'Imported documents stay read-only here. Re-import the source file to replace its contents.'
    : isInlineText && !sourceIsManual
      ? 'This document was added by a crawl or sync. Re-crawl the source to refresh it.'
      : null

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {isFailed ? (
        <Button type="button" variant="outline" onClick={onRetry} disabled={isSaving || isDeleting || isRetrying}>
          {isRetrying ? <Spinner className="mr-2" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Retry processing
        </Button>
      ) : null}
      <Button type="button" variant="outline" onClick={onInspectChunks}>
        <Boxes className="mr-2 h-4 w-4" />
        Chunks
      </Button>
      <Button type="button" variant="outline" onClick={() => onMetadataOpenChange(!isMetadataOpen)}>
        <PanelRight className="mr-2 h-4 w-4" />
        Properties
      </Button>
      {isEditing ? (
        <>
          <Button type="button" variant="outline" onClick={() => onEditingChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving || !values.title.trim() || !values.content.trim()}>
            {isSaving ? <Spinner className="mr-2" /> : <Save className="mr-2 h-4 w-4" />}
            Save document
          </Button>
        </>
      ) : isEditable ? (
        <Button type="button" onClick={() => onEditingChange(true)}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} aria-disabled="true">
              <Button type="button" disabled className="pointer-events-none">
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </Button>
            </span>
          </TooltipTrigger>
          {readOnlyExplanation ? (
            <TooltipContent>{readOnlyExplanation}</TooltipContent>
          ) : null}
        </Tooltip>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onDelete}
        disabled={isSaving || isDeleting}
      >
        {isDeleting ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
        <span className="sr-only">Delete document</span>
      </Button>
    </div>
  )

  return (
    <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="sticky top-0 z-30 space-y-3 border-b border-border bg-background/95 px-6 py-4 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="ghost" className="-ml-3 h-8 px-3 text-muted-foreground" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to documents
            </Button>
            {headerActions}
          </div>
          <div className="min-w-0">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {isEditing ? (
                  <Input
                    id="document-title"
                    value={values.title}
                    onChange={(event) => onChange('title', event.target.value)}
                    disabled={isSaving}
                    className="h-11 min-w-[20rem] max-w-3xl border-border bg-background text-xl font-semibold [overflow-wrap:anywhere]"
                  />
                ) : (
                  <h1 className="text-xl font-semibold text-foreground [overflow-wrap:anywhere]">{document.title}</h1>
                )}
                <DocumentStatus status={document.status} />
              </div>
              {isFailed && document.failureReason ? (
                <p className="text-sm text-destructive">{document.failureReason}</p>
              ) : null}
              {retryError ? (
                <p className="text-sm text-destructive">{retryError}</p>
              ) : null}
              {saveError && isEditing ? (
                <p className="text-sm text-destructive">{saveError}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>
                  Updated {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(document.updatedAt))}
                </span>
                {document.sourceFilename ? <span>{document.sourceFilename}</span> : null}
                {sourceName ? (
                  <span className="inline-flex items-center gap-1">
                    <span>Source</span>
                    {sourceFilterHref ? (
                      <Link
                        href={sourceFilterHref}
                        className="font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {sourceName}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground">{sourceName}</span>
                    )}
                  </span>
                ) : null}
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  >
                    Open original
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="w-full">
                {isEditing ? (
                  <Textarea
                    id="document-content"
                    value={values.content}
                    onChange={(event) => onChange('content', event.target.value)}
                    disabled={isSaving}
                    className="min-h-[65vh] resize-none overflow-y-auto [field-sizing:fixed]"
                  />
                ) : (
                  <div
                    id="document-content"
                    className="min-h-[65vh] rounded-md bg-muted/30 px-4 py-3 text-sm leading-7 text-foreground [overflow-wrap:anywhere]"
                  >
                    {values.content.trim().length > 0 ? (
                      <MarkdownContent content={values.content} variant="document" />
                    ) : (
                      <p className="text-muted-foreground">This document has no content.</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <aside
              className={cn(
                'absolute inset-y-0 right-0 z-10 flex w-full max-w-xl flex-col border-l border-border bg-background shadow-2xl transition-transform duration-300 ease-out',
                isMetadataOpen ? 'translate-x-0' : 'translate-x-full',
              )}
              aria-hidden={!isMetadataOpen}
            >
              <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4">
                <h2 className="font-semibold text-foreground">Properties</h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => onMetadataOpenChange(false)}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close properties</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <div className="space-y-1">
                  <label
                    htmlFor="document-source"
                    className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    Source
                  </label>
                  {canEditSource ? (
                    <Select
                      value={values.sourceId}
                      onValueChange={onSourceChange}
                      disabled={isSaving}
                    >
                      <SelectTrigger id="document-source" className="w-full">
                        <SelectValue placeholder="Select a source" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableSources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm text-foreground [overflow-wrap:anywhere]">
                      {currentSourceName}
                    </p>
                  )}
                  {isEditing && isEditable && !sourceIsManual ? (
                    <p className="text-xs text-muted-foreground">
                      Source is locked because this document came from a crawl or import.
                    </p>
                  ) : null}
                </div>
                {enrichment || onRunMetadataExtraction ? (
                  <div className="space-y-2 border-t border-border/70 pt-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Extracted metadata
                    </p>
                    {enrichment ? (
                      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
                        {enrichmentRows.map(([label, value]) => (
                          <div key={label} className="contents">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="text-foreground [overflow-wrap:anywhere]">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No metadata has been extracted for this document yet.
                      </p>
                    )}
                    {enrichment?.failureReason ? (
                      <p className="text-sm text-destructive [overflow-wrap:anywhere]">{enrichment.failureReason}</p>
                    ) : null}
                    {onRunMetadataExtraction ? (
                      <div className="space-y-1 pt-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onRunMetadataExtraction}
                          disabled={Boolean(isRunningMetadataExtraction)}
                        >
                          {isRunningMetadataExtraction ? <Spinner className="mr-2 h-3.5 w-3.5" /> : null}
                          Run metadata extraction
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          Processes this document again with metadata extraction forced on for that run.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="space-y-1">
                  <label htmlFor="document-metadata" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Metadata
                  </label>
                  <Textarea
                    id="document-metadata"
                    value={values.metadata}
                    onChange={(event) => onMetadataChange(event.target.value)}
                    placeholder='{"key": "value"}'
                    readOnly={!isEditing}
                    disabled={isSaving}
                    className="min-h-[60vh] resize-none font-mono text-sm"
                  />
                  {metadataError ? <p className="mt-2 text-sm text-destructive">{metadataError}</p> : null}
                </div>
              </div>
            </aside>
          </div>
        </div>
    </form>
  )
}
