'use client'

import type { FormEvent } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'

export type DocumentDialogEnrichmentChoice = 'inherit' | 'on' | 'off'

export function DocumentImportDialog({
  open,
  importTitle,
  importError,
  isImporting,
  supportedExtensions,
  enrichmentChoice,
  onEnrichmentChoiceChange,
  onOpenChange,
  onSubmit,
  onTitleChange,
  onFileChange,
  hasFile,
}: {
  open: boolean
  importTitle: string
  importError: string | null
  isImporting: boolean
  supportedExtensions: string
  enrichmentChoice: DocumentDialogEnrichmentChoice
  onEnrichmentChoiceChange: (value: DocumentDialogEnrichmentChoice) => void
  onOpenChange: (open: boolean) => void
  onSubmit: (event: FormEvent) => void
  onTitleChange: (value: string) => void
  onFileChange: (file: File | null) => void
  hasFile: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Document</DialogTitle>
          <DialogDescription>
            Upload a PDF, Markdown, TXT, DOCX, or XLSX file to add it to your knowledge base.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="importFile">File</Label>
            <Input
              id="importFile"
              type="file"
              accept={supportedExtensions}
              disabled={isImporting}
              onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="importTitle">Title override (optional)</Label>
            <Input
              id="importTitle"
              value={importTitle}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Use the filename by default"
              disabled={isImporting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="importEnrichment">Metadata extraction</Label>
            <Select
              value={enrichmentChoice}
              onValueChange={(value) => onEnrichmentChoiceChange(value as DocumentDialogEnrichmentChoice)}
              disabled={isImporting}
            >
              <SelectTrigger id="importEnrichment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Use workspace setting</SelectItem>
                <SelectItem value="on">On for this document</SelectItem>
                <SelectItem value="off">Off for this document</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Understands the document type and extracts structured tags like event dates (one extra AI call).
            </p>
          </div>
          {importError ? (
            <p className="text-sm text-destructive" role="alert">
              {importError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isImporting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isImporting || !hasFile}>
              {isImporting ? <Spinner className="mr-2" /> : null}
              Import Document
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
