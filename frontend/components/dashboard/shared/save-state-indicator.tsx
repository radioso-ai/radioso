'use client'

import { CheckCircle2, CircleAlert, Clock3 } from 'lucide-react'

export type SaveStateIndicatorState = {
  state: 'idle' | 'saved' | 'saving' | 'error'
  message?: string | null
}

export function SaveStateIndicator({ saveState }: { saveState: SaveStateIndicatorState }) {
  if (saveState.state === 'idle') {
    return null
  }

  if (saveState.state === 'saving') {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium leading-none text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
        Saving...
      </span>
    )
  }

  if (saveState.state === 'error') {
    return (
      <span
        className="inline-flex min-w-0 shrink items-center gap-1 text-xs font-medium leading-none text-destructive"
        role="status"
        aria-live="polite"
      >
        <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{saveState.message ?? 'Failed to save changes'}</span>
      </span>
    )
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium leading-none text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      Saved
    </span>
  )
}
