'use client'

import type { FormEvent } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

export function DocumentImportDialog({
  open,
  importTitle,
  importError,
  isImporting,
  supportedExtensions,
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
            Upload a PDF, TXT, DOCX, or XLSX file to add it to your knowledge base.
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
