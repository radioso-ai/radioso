'use client'

import type { FormEvent } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

type EditorMode = 'create' | 'edit' | 'view'

export type DocumentEditorValues = {
  title: string
  content: string
  metadata: string
}

export function DocumentEditorDialog({
  open,
  mode,
  values,
  metadataError,
  isSaving,
  isLoading,
  onOpenChange,
  onChange,
  onMetadataChange,
  onSubmit,
}: {
  open: boolean
  mode: EditorMode
  values: DocumentEditorValues
  metadataError: string | null
  isSaving: boolean
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onChange: (field: keyof DocumentEditorValues, value: string) => void
  onMetadataChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
}) {
  const isReadOnly = mode === 'view'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,760px)] max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit' ? 'Edit Document' : mode === 'view' ? 'View Document' : 'Add Document'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'edit'
              ? 'Update the document and re-run it through the RAG ingestion pipeline.'
              : mode === 'view'
                ? 'Review the extracted contents of an imported document.'
                : 'Add a new document to your knowledge base for retrieval.'}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex flex-1 min-h-[240px] items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : (
          <form
            onSubmit={isReadOnly ? (event) => event.preventDefault() : onSubmit}
            className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <div className="space-y-2 flex-shrink-0">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={values.title}
                  onChange={(event) => onChange('title', event.target.value)}
                  placeholder="Document title"
                  disabled={isSaving || isReadOnly}
                  readOnly={isReadOnly}
                />
              </div>
              <div className="space-y-2 flex-shrink-0">
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  value={values.content}
                  onChange={(event) => onChange('content', event.target.value)}
                  placeholder="Paste your document content here..."
                  className="min-h-[320px] resize-none overflow-y-auto [field-sizing:fixed]"
                  disabled={isSaving || isReadOnly}
                  readOnly={isReadOnly}
                />
              </div>
              <div className="space-y-2 flex-shrink-0">
                <Label htmlFor="metadata">Metadata (JSON)</Label>
                <Textarea
                  id="metadata"
                  value={values.metadata}
                  onChange={(event) => onMetadataChange(event.target.value)}
                  placeholder='{"key": "value"}'
                  className="min-h-[80px] resize-none font-mono text-sm"
                  disabled={isSaving || isReadOnly}
                  readOnly={isReadOnly}
                />
                {metadataError ? <p className="text-sm text-destructive">{metadataError}</p> : null}
              </div>
            </div>
            <div className="mt-4 flex flex-shrink-0 justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                {isReadOnly ? 'Close' : 'Cancel'}
              </Button>
              {isReadOnly ? null : (
                <Button type="submit" disabled={isSaving || !values.title.trim() || !values.content.trim()}>
                  {isSaving ? <Spinner className="mr-2" /> : null}
                  {mode === 'edit' ? 'Save Document' : 'Add Document'}
                </Button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
