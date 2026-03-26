'use client'

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
import { Spinner } from '@/components/ui/spinner'
import type { DocumentSummary } from '@/lib/api'

export function DocumentDeleteDialog({
  candidate,
  deletingDocumentId,
  error,
  onOpenChange,
  onConfirm,
}: {
  candidate: DocumentSummary | null
  deletingDocumentId: string | null
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={candidate !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete document?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently remove{' '}
            <span className="font-medium text-foreground">{candidate?.title ?? 'this document'}</span>{' '}
            from your knowledge base.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(deletingDocumentId)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
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
  )
}
