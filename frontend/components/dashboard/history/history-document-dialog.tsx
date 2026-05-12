'use client'

import { MarkdownContent } from '@/components/markdown/markdown-content'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { LogoSpinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { DocumentDetails } from '@/lib/api'

export function HistoryDocumentDialog({
  open,
  isLoading,
  error,
  document,
  onOpenChange,
}: {
  open: boolean
  isLoading: boolean
  error: string | null
  document: DocumentDetails | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,760px)] max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>View Document</DialogTitle>
          <DialogDescription>
            Review the document without leaving the current activity view.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : document ? (
          <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <div className="space-y-2">
                <Label htmlFor="historyDocumentTitle">Title</Label>
                <div
                  id="historyDocumentTitle"
                  className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground"
                >
                  {document.title}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="historyDocumentContent">Content</Label>
                <div
                  id="historyDocumentContent"
                  className="min-h-[320px] overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2 text-sm leading-7 text-foreground [overflow-wrap:anywhere]"
                >
                  {document.content.trim().length > 0 ? (
                    <MarkdownContent content={document.content} variant="document" />
                  ) : (
                    <p className="text-muted-foreground">This document has no content.</p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="historyDocumentMetadata">Metadata</Label>
                <Textarea
                  id="historyDocumentMetadata"
                  value={
                    Object.keys(document.metadata ?? {}).length > 0
                      ? JSON.stringify(document.metadata, null, 2)
                      : '{}'
                  }
                  readOnly
                  className="min-h-[120px] resize-none font-mono text-sm"
                />
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
