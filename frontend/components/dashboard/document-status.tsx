'use client'

import { AlertCircle, Ban, CalendarClock, CalendarX, CheckCircle2, Loader2 } from 'lucide-react'

import {
  getDocumentRetrievalState,
  type DocumentRetrievalFields,
} from '@/lib/document-retrieval'
import { cn } from '@/lib/utils'

interface DocumentStatusProps {
  status: string
}

const normalizeStatus = (status: string): 'queued' | 'processing' | 'ready' | 'failed' => {
  const normalized = status.toLowerCase()

  if (normalized === 'ready') {
    return 'ready'
  }

  if (normalized === 'failed') {
    return 'failed'
  }

  if (normalized === 'queued') {
    return 'queued'
  }

  return 'processing'
}

const getStatusLabel = (status: string): string => {
  const normalized = status.toLowerCase()

  if (normalized === 'ready') {
    return 'Ready'
  }

  if (normalized === 'failed') {
    return 'Failed'
  }

  if (normalized === 'queued') {
    return 'Queued'
  }

  return 'Processing'
}

export function DocumentStatus({ status }: DocumentStatusProps) {
  const normalizedStatus = normalizeStatus(status)
  const label = getStatusLabel(status)

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-foreground">
      {normalizedStatus === 'ready' ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
      ) : normalizedStatus === 'failed' ? (
        <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
      )}
      <span>{label}</span>
    </div>
  )
}

const formatExpiryDate = (iso: string | null): string | null => {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

/**
 * Retrieval-eligibility badge. Renders nothing for an ordinary included
 * document; makes excluded and expired documents stand out, and hints at a
 * scheduled auto-exclude date.
 */
export function DocumentRetrievalBadge({
  document,
  className,
}: {
  document: DocumentRetrievalFields
  className?: string
}) {
  const state = getDocumentRetrievalState(document)
  if (state === 'included') {
    return null
  }

  const expiryLabel = formatExpiryDate(document.retrievalExpiresAt)

  const base = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium'

  if (state === 'excluded') {
    return (
      <span
        className={cn(base, 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400', className)}
        title="Excluded from retrieval"
      >
        <Ban className="h-3.5 w-3.5" aria-hidden="true" />
        Excluded
      </span>
    )
  }

  if (state === 'expired') {
    return (
      <span
        className={cn(base, 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400', className)}
        title={expiryLabel ? `Auto-excluded on ${expiryLabel}` : 'Auto-excluded'}
      >
        <CalendarX className="h-3.5 w-3.5" aria-hidden="true" />
        Expired
      </span>
    )
  }

  // scheduled: still retrievable, will auto-exclude on a future date.
  return (
    <span
      className={cn(base, 'border-border bg-muted/40 text-muted-foreground', className)}
      title={expiryLabel ? `Auto-excludes on ${expiryLabel}` : undefined}
    >
      <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
      {expiryLabel ? `Expires ${expiryLabel}` : 'Scheduled'}
    </span>
  )
}
