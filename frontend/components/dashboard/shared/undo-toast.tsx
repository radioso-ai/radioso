'use client'

import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

const VISIBLE_MS = 6_000

/**
 * A short notice at the foot of the page that an action happened, with Undo when it can be taken
 * back. It closes itself after a few seconds; `key` it by the action so a new one restarts the timer.
 */
export function UndoToast({
  message,
  onUndo,
  onClose,
}: {
  message: string
  onUndo?: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [onClose])

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md bg-foreground py-2 pl-4 pr-2 text-sm text-background shadow-lg"
    >
      <span className="min-w-0 truncate">{message}</span>
      {onUndo ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-background hover:bg-background/15 hover:text-background dark:hover:bg-background/15 dark:hover:text-background"
          onClick={() => {
            onUndo()
            onClose()
          }}
        >
          Undo
        </Button>
      ) : null}
    </div>
  )
}
