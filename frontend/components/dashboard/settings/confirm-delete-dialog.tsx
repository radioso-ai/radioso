'use client'

import { useState, type ReactNode } from 'react'

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

// The one confirmation every settings delete asks for. The confirm button never closes the dialog
// itself: the caller closes it once the delete settles, so a failure's error shows in the surface
// underneath instead of being hidden behind a dialog that went away early.
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
}) {
  return (
    // Escape and a click outside close the dialog too, so they wait while the delete runs.
    <AlertDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

type DeleteConfirmation<Item> = {
  // The item the dialog asks about. It outlives the dialog's closing so the text does not change
  // while the dialog fades out.
  item: Item | null
  isOpen: boolean
  ask: (item: Item) => void
  dismiss: () => void
}

export function useDeleteConfirmation<Item>(): DeleteConfirmation<Item> {
  const [asked, setAsked] = useState<{ item: Item; isOpen: boolean } | null>(null)
  return {
    item: asked?.item ?? null,
    isOpen: asked?.isOpen ?? false,
    ask: (item) => setAsked({ item, isOpen: true }),
    dismiss: () => setAsked((current) => (current ? { ...current, isOpen: false } : current)),
  }
}
