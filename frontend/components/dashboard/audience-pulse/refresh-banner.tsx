'use client'

import { AlertTriangle, Info } from 'lucide-react'

import { Spinner } from '@/components/ui/spinner'

import { formatDayMonthTime } from './pulse-dates'

export type RefreshState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'preparing' }
  | { kind: 'cancelled' }
  | { kind: 'busy' }
  | { kind: 'capacity'; message: string }
  | { kind: 'unavailable'; reason: 'provider' | 'validation' | 'census' | 'cancelled' }
  | { kind: 'error'; message: string }

export function RefreshBanner({
  state,
  hasSavedReport,
  lastRefreshEndedAt,
}: {
  state: RefreshState
  hasSavedReport: boolean
  lastRefreshEndedAt: string | null
}) {
  if (state.kind === 'idle' || state.kind === 'running') {
    return null
  }
  const finishedAt = lastRefreshEndedAt ? formatDayMonthTime(lastRefreshEndedAt) : null
  const commonClass = 'flex items-start gap-3 rounded-md border p-3 text-sm'

  if (state.kind === 'preparing') {
    return (
      <div className={`${commonClass} border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100`} role="status">
        <Spinner className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Preparing your report from all pending visitor questions.</p>
          <p className="text-xs opacity-80">This continues automatically; you do not need to refresh the page or click again.</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'busy') {
    return (
      <div className={`${commonClass} border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Another refresh is already running for this workspace.</p>
          <p className="text-xs opacity-80">Try again in a moment.</p>
        </div>
      </div>
    )
  }
  if (state.kind === 'capacity') {
    return (
      <div className={`${commonClass} border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Refresh capacity reached.</p>
          <p className="text-xs opacity-80">{state.message}</p>
        </div>
      </div>
    )
  }
  if (state.kind === 'cancelled') {
    return (
      <div className={`${commonClass} border-muted bg-muted/50 text-muted-foreground`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>Refresh was cancelled. The saved report is unchanged.</p>
      </div>
    )
  }
  if (state.kind === 'unavailable') {
    return (
      <div className={`${commonClass} border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100`} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">We couldn&apos;t complete the analysis. Try again in a moment.</p>
          {hasSavedReport ? (
            <p className="text-xs opacity-80">
              The previous report is still shown{finishedAt ? ` (attempt ended ${finishedAt})` : ''}.
            </p>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div className={`${commonClass} border-destructive/40 bg-destructive/10 text-destructive`} role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">Refresh failed.</p>
        <p className="text-xs opacity-80">
          {state.message}
          {hasSavedReport && finishedAt ? ` The previous saved report is still shown (attempt ended ${finishedAt}).` : null}
        </p>
      </div>
    </div>
  )
}
