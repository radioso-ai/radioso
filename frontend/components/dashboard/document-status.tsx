'use client'

import { AlertCircle, Ban, CalendarX, CheckCircle2, Loader2 } from 'lucide-react'

import {
  getDocumentRetrievalState,
  type DocumentRetrievalFields,
} from '@/lib/document-retrieval'
import { cn } from '@/lib/utils'

type ProcessingStatus = 'queued' | 'processing' | 'ready' | 'failed'

const normalizeStatus = (status: string): ProcessingStatus => {
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

const processingLabel: Record<ProcessingStatus, string> = {
  ready: 'Ready',
  failed: 'Failed',
  queued: 'Queued',
  processing: 'Processing',
}

const pillClass = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium'

type DocumentStatusInput = DocumentRetrievalFields & { status: string }

/**
 * A document's single status badge. While the document is still processing (or
 * failed) that is the only status shown. Once it is `ready`, retrieval
 * eligibility takes over: a document that has been turned off or has expired
 * reads as Excluded / Expired instead of Ready, so the list and the detail
 * header never show two competing statuses.
 */
export function DocumentStatus({ document }: { document: DocumentStatusInput }) {
  const processing = normalizeStatus(document.status)

  if (processing !== 'ready') {
    return (
      <div className={cn(pillClass, 'border-border text-foreground')}>
        {processing === 'failed' ? (
          <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
        )}
        <span>{processingLabel[processing]}</span>
      </div>
    )
  }

  const retrievalState = getDocumentRetrievalState(document)

  if (retrievalState === 'excluded') {
    return (
      <div
        className={cn(pillClass, 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400')}
        title="Excluded from retrieval"
      >
        <Ban className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Excluded</span>
      </div>
    )
  }

  if (retrievalState === 'expired') {
    return (
      <div
        className={cn(pillClass, 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400')}
        title="Auto-excluded from retrieval"
      >
        <CalendarX className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Expired</span>
      </div>
    )
  }

  // included or scheduled: the document is retrievable now.
  return (
    <div className={cn(pillClass, 'border-border text-foreground')}>
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
      <span>Ready</span>
    </div>
  )
}
