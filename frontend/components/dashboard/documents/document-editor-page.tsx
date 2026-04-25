'use client'

import type { FormEvent } from 'react'
import { ArrowLeft, FileText, PanelRight, Pencil, Save, X } from 'lucide-react'

import { DocumentStatus } from '@/components/dashboard/document-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { DocumentSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

export type DocumentEditorValues = {
  title: string
  content: string
  metadata: string
}

export function DocumentEditorPage({
  document,
  values,
  metadataError,
  isLoading,
  isSaving,
  isEditing,
  isMetadataOpen,
  onBack,
  onChange,
  onMetadataChange,
  onEditingChange,
  onMetadataOpenChange,
  onSubmit,
}: {
  document: DocumentSummary | null
  values: DocumentEditorValues
  metadataError: string | null
  isLoading: boolean
  isSaving: boolean
  isEditing: boolean
  isMetadataOpen: boolean
  onBack: () => void
  onChange: (field: keyof DocumentEditorValues, value: string) => void
  onMetadataChange: (value: string) => void
  onEditingChange: (editing: boolean) => void
  onMetadataOpenChange: (open: boolean) => void
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

  const isEditable = document.sourceKind === 'inline_text'

  return (
    <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="sticky top-0 z-30 flex flex-wrap items-start justify-between gap-4 border-b border-border bg-background/95 px-6 py-4 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="min-w-0 space-y-3">
            <Button type="button" variant="ghost" className="-ml-3 h-8 px-3 text-muted-foreground" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to documents
            </Button>
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
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>
                  Updated {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(document.updatedAt))}
                </span>
                {document.sourceFilename ? <span>{document.sourceFilename}</span> : null}
                <span>{isEditable ? 'Inline document' : 'Imported document'}</span>
              </div>
              {!isEditable ? (
                <p className="text-sm text-muted-foreground">
                  Imported documents stay read-only here. Re-import the source file to replace its contents.
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onMetadataOpenChange(true)}>
              <PanelRight className="mr-2 h-4 w-4" />
              Metadata
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
            ) : null}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="w-full">
                <Textarea
                  id="document-content"
                  value={values.content}
                  onChange={(event) => onChange('content', event.target.value)}
                  readOnly={!isEditing}
                  disabled={isSaving}
                  className={`min-h-[65vh] resize-none overflow-y-auto [field-sizing:fixed] ${!isEditing ? 'border-transparent bg-muted/30 shadow-none' : ''}`}
                />
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
                <h2 className="font-semibold text-foreground">Metadata</h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => onMetadataOpenChange(false)}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close metadata</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <Textarea
                  id="document-metadata"
                  value={values.metadata}
                  onChange={(event) => onMetadataChange(event.target.value)}
                  placeholder='{"key": "value"}'
                  readOnly={!isEditing}
                  disabled={isSaving}
                  className="min-h-[70vh] resize-none font-mono text-sm"
                />
                {metadataError ? <p className="mt-2 text-sm text-destructive">{metadataError}</p> : null}
              </div>
            </aside>
          </div>
        </div>
    </form>
  )
}
