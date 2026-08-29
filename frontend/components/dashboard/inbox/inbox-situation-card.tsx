'use client'

import { AlertTriangle } from 'lucide-react'

import { selectSituationBody, type SituationSource } from '@/lib/inbox-response'

/**
 * Leads with the handoff reason when one exists (FR-007), then the situation
 * body — the stored rolling summary when available, otherwise the visitor's
 * first message. `selectSituationBody` isolates that fallback chain so a real
 * summary source can replace it later without reshaping this component.
 */
export function InboxSituationCard(source: SituationSource) {
  const body = selectSituationBody(source)
  if (!source.handoffReason && !body) {
    return null
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
      {source.handoffReason ? (
        <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Handed off — {source.handoffReason}
        </p>
      ) : null}
      {body ? <p className="text-sm text-foreground">{body}</p> : null}
    </div>
  )
}
