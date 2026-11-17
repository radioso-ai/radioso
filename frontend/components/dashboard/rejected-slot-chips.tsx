'use client'

import { REJECTED_SLOT_REASONS, type RejectedSlotReason, type RoutineRejectedSlotView } from '@/lib/routine-run-trace'

// Undeclared keys are the model's own extras, not an authoring problem, so they read quietly.
const REJECTED_SLOT_LABELS: Record<RejectedSlotReason, { label: string; hint: string; tone: string }> = {
  undeclared: {
    label: 'ignored, not a slot',
    hint: 'The model returned a key this routine does not declare, so it was dropped.',
    tone: 'bg-muted text-muted-foreground',
  },
  consent: {
    label: 'not stored, no consent',
    hint: 'The slot is covered by a consent the visitor had not granted.',
    tone: 'bg-amber-500/10 text-amber-600',
  },
  type_mismatch: {
    label: 'not stored, wrong type',
    hint: "The value did not fit the slot's type.",
    tone: 'bg-amber-500/10 text-amber-600',
  },
  not_scalar: {
    label: 'not stored, not a single value',
    hint: 'The slot takes one value; the model returned a list or an object.',
    tone: 'bg-amber-500/10 text-amber-600',
  },
}

/** A step's unstored slots, grouped by why each was not stored. */
export function RejectedSlotChips({ slots }: { slots: RoutineRejectedSlotView[] }) {
  return (
    <>
      {REJECTED_SLOT_REASONS.map((reason) => {
        const keys = slots.filter((slot) => slot.reason === reason).map((slot) => slot.key)
        if (keys.length === 0) {
          return null
        }
        const { label, hint, tone } = REJECTED_SLOT_LABELS[reason]
        return (
          <div key={reason} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground" title={hint}>
              {label}
            </span>
            <ul className="flex flex-wrap gap-1">
              {keys.map((key) => (
                <li key={key} className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${tone}`}>
                  {key}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}
