'use client'

import { AlertTriangle, Image as ImageIcon } from 'lucide-react'

import { handoffReasonLabel } from '@/lib/conversation-activity'
import { selectSituationBody, type SituationSource } from '@/lib/inbox-response'
import { photoCountLabel } from '@/lib/visitor-image-input'

/**
 * Leads with the handoff reason when one exists (FR-007), then the situation
 * body — the stored rolling summary when available, otherwise what the visitor
 * typed in their first message, with a short marker for the photos that came
 * with it (the readings stay in the thread, behind "What the agent read").
 * `selectSituationBody` isolates that fallback chain so a real summary source
 * can replace it later without reshaping this component.
 */
export function InboxSituationCard(source: SituationSource) {
  const body = selectSituationBody(source)
  const reason = handoffReasonLabel(source.handoffReason)
  if (!reason && !body) {
    return null
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
      {reason ? (
        <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Handed off — {reason}
        </p>
      ) : null}
      {body?.text.trim() ? <p className="text-sm text-foreground">{body.text}</p> : null}
      {body && body.photoCount > 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground first:mt-0">
          <ImageIcon className="h-3 w-3 shrink-0" aria-hidden />
          {photoCountLabel(body.photoCount)}
        </p>
      ) : null}
    </div>
  )
}
