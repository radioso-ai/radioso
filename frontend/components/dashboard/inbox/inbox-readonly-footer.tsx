'use client'

import { CheckCircle2, Circle } from 'lucide-react'

import type { ConversationOutcome } from '@/lib/conversation-outcome'

/**
 * The response view's footer when the selected conversation isn't actionable
 * (not awaiting a human, not human-owned) — a muted strip in place of the
 * composer, replacing it rather than disabling it (there is nothing for the
 * operator to act on). Only the All lens renders this; the Needs-you lens's
 * items are always actionable.
 */
export function InboxReadOnlyFooter({
  outcome,
  handledByLabel,
}: {
  /**
   * Never actually `handed_off` in practice — a handed-off conversation is
   * actionable, so the response view renders the composer instead of this
   * footer for it — but typed as the full outcome rather than a narrowed
   * variant so the caller doesn't need an unsafe cast to pass it through.
   */
  outcome: ConversationOutcome
  handledByLabel: string | null
}) {
  const isCompleted = outcome.kind === 'completed'

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-6 py-3 text-xs text-muted-foreground">
      {isCompleted ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
      ) : (
        <Circle className="h-2 w-2 shrink-0 fill-primary text-primary" aria-hidden />
      )}
      <span>{isCompleted ? 'Completed' : 'In progress'}</span>
      {handledByLabel ? (
        <>
          <span aria-hidden>·</span>
          <span>{handledByLabel}</span>
        </>
      ) : null}
    </div>
  )
}
