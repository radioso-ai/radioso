'use client'

import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  QUALITY_NOT_ACTIONABLE_REASONS,
  QUALITY_RESOLVED_REASONS,
  type QualityResolutionReason,
  type QualityTriageRecord,
} from '@/lib/api-quality'

type TerminalTriageState = 'resolved' | 'dismissed'

const REASON_LABELS: Record<QualityResolutionReason, string> = {
  knowledge_gap: 'Knowledge gap',
  retrieval_issue: 'Retrieval or configuration issue',
  agent_behavior: 'Agent behavior issue',
  platform_bug: 'Platform or integration issue',
  expected_behavior: 'Expected behavior',
  out_of_scope: 'Outside the agent’s scope',
  invalid_feedback: 'Invalid or insufficient feedback',
  other: 'Other',
}

export interface CloseReviewInput {
  state: TerminalTriageState
  resolution: {
    reason: QualityResolutionReason
    note: string | null
  }
}

interface CloseReviewDialogProps {
  open: boolean
  state: TerminalTriageState
  submitting: boolean
  error?: string | null
  conflict?: QualityTriageRecord | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: CloseReviewInput) => void | Promise<void>
}

const TRIAGE_STATE_LABELS: Record<QualityTriageRecord['state'], string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

export function CloseReviewDialog({
  open,
  state,
  submitting,
  error,
  conflict,
  onOpenChange,
  onSubmit,
}: CloseReviewDialogProps) {
  const [reason, setReason] = useState<QualityResolutionReason | null>(null)
  const [note, setNote] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirmedConflictVersion, setConfirmedConflictVersion] = useState<number | null>(null)
  const reasonGroupId = useId()
  const noteId = useId()
  const replacementId = useId()

  const reasons = state === 'resolved'
    ? QUALITY_RESOLVED_REASONS
    : QUALITY_NOT_ACTIONABLE_REASONS
  const actionLabel = state === 'resolved' ? 'Resolve review' : 'Mark not actionable'
  const submitLabel = conflict ? 'Replace current decision' : actionLabel
  const replacementConfirmed = Boolean(
    conflict && confirmedConflictVersion === conflict.version,
  )

  const submit = () => {
    if (conflict && !replacementConfirmed) {
      return
    }
    if (!reason) {
      setValidationError('Choose the reason that best explains this decision.')
      return
    }
    const trimmedNote = note.trim()
    if (reason === 'other' && !trimmedNote) {
      setValidationError('Add a short note when you choose Other.')
      return
    }
    setValidationError(null)
    void onSubmit({
      state,
      resolution: {
        reason,
        note: trimmedNote || null,
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>
            Choose one reason so closed reviews become useful evidence. You can add a private
            operator note for context.
          </DialogDescription>
        </DialogHeader>

        {conflict ? (
          <section
            className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
            aria-labelledby={`${replacementId}-heading`}
            role="alert"
          >
            <div>
              <h3 id={`${replacementId}-heading`} className="text-sm font-semibold">
                Another operator updated this review
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Review their current decision before choosing whether to replace it.
                Your reason and note are preserved.
              </p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="font-medium">State</dt>
              <dd>{TRIAGE_STATE_LABELS[conflict.state]}</dd>
              <dt className="font-medium">Reason</dt>
              <dd>
                {conflict.resolution
                  ? REASON_LABELS[conflict.resolution.reason]
                  : conflict.legacyReason ?? 'Not recorded'}
              </dd>
              <dt className="font-medium">Private note</dt>
              <dd className="whitespace-pre-wrap break-words">
                {conflict.resolution?.note ?? 'Not recorded'}
              </dd>
              <dt className="font-medium">Closed</dt>
              <dd>
                {conflict.closedAt ? (
                  <time dateTime={conflict.closedAt}>
                    {new Date(conflict.closedAt).toLocaleString()}
                  </time>
                ) : 'Not closed'}
              </dd>
            </dl>
            <label className="flex cursor-pointer items-start gap-2 text-sm font-medium">
              <input
                id={replacementId}
                type="checkbox"
                checked={replacementConfirmed}
                onChange={(event) => setConfirmedConflictVersion(
                  event.target.checked && conflict ? conflict.version : null,
                )}
                disabled={submitting}
                className="mt-0.5"
              />
              <span>I reviewed the current decision and want to replace it.</span>
            </label>
          </section>
        ) : null}

        <fieldset
          className="space-y-2"
          aria-describedby={validationError ? `${reasonGroupId}-error` : undefined}
        >
          <legend className="text-sm font-medium">Reason</legend>
          {reasons.map((value) => (
            <label
              key={value}
              className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent"
            >
              <input
                type="radio"
                name={reasonGroupId}
                value={value}
                checked={reason === value}
                onChange={() => {
                  setReason(value)
                  setValidationError(null)
                }}
                disabled={submitting}
              />
              <span>{REASON_LABELS[value]}</span>
            </label>
          ))}
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor={noteId}>
            Note {reason === 'other' ? '(required)' : '(optional)'}
          </Label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            rows={3}
            disabled={submitting}
            aria-invalid={Boolean(validationError && reason === 'other')}
            placeholder="What changed, or why isn’t this actionable?"
          />
          <p className="text-xs text-muted-foreground">{note.length}/500 characters</p>
        </div>

        {validationError || error ? (
          <p
            id={`${reasonGroupId}-error`}
            className="text-sm text-destructive"
            role="alert"
          >
            {validationError ?? error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {conflict ? 'Keep current decision' : 'Cancel'}
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || Boolean(conflict && !replacementConfirmed)}
          >
            {submitting ? 'Saving…' : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { REASON_LABELS }
