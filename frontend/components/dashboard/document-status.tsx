'use client'

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

interface DocumentStatusProps {
  status: string
}

const normalizeStatus = (status: string): 'ready' | 'failed' | 'processing' => {
  const normalized = status.toLowerCase()

  if (normalized === 'ready') {
    return 'ready'
  }

  if (normalized === 'failed') {
    return 'failed'
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
