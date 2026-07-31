'use client'

import * as Popover from '@radix-ui/react-popover'
import { useId, useMemo, useState } from 'react'

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
  } | null
}

interface CloseReviewPopoverProps {
  open: boolean
  anchor: HTMLElement | null
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

export function CloseReviewPopover({
  open,
  anchor,
  state,
  submitting,
  error,
  conflict,
  onOpenChange,
  onSubmit,
}: CloseReviewPopoverProps) {
  const [otherSelected, setOtherSelected] = useState(false)
  const [note, setNote] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [proposedInput, setProposedInput] = useState<CloseReviewInput | null>(null)
  const [confirmedConflictVersion, setConfirmedConflictVersion] = useState<number | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const noteId = useId()
  const replacementId = useId()
  const virtualAnchor = useMemo(() => anchor ? { current: anchor } : undefined, [anchor])

  const reasons = state === 'resolved'
    ? QUALITY_RESOLVED_REASONS
    : QUALITY_NOT_ACTIONABLE_REASONS
  const actionLabel = state === 'resolved' ? 'Resolve review' : 'Mark not actionable'
  const replacementConfirmed = Boolean(
    conflict && confirmedConflictVersion === conflict.version,
  )

  const submit = (resolution: CloseReviewInput['resolution']) => {
    const input = { state, resolution }
    setValidationError(null)
    setProposedInput(input)
    void onSubmit(input)
  }

  const submitOther = () => {
    const trimmedNote = note.trim()
    if (!trimmedNote) {
      setValidationError('Add a short note when you choose Other.')
      return
    }
    submit({ reason: 'other', note: trimmedNote })
  }

  return (
    <>
      <Popover.Root
        open={open && !conflict}
        onOpenChange={(next) => {
          if (!submitting) onOpenChange(next)
        }}
        modal={false}
      >
        {virtualAnchor ? <Popover.Anchor virtualRef={virtualAnchor} /> : null}
        <Popover.Portal>
          <Popover.Content
            role="dialog"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            sideOffset={8}
            collisionPadding={12}
            align="end"
            className="z-50 max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-1.5rem))] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            onClick={(event) => event.stopPropagation()}
            onFocusOutside={(event) => {
              if (event.target === anchor) event.preventDefault()
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              const activeElement = document.activeElement
              const content = event.currentTarget
              const focusLeftPopover = activeElement instanceof HTMLElement
                && activeElement !== document.body
                && content instanceof HTMLElement
                && !content.contains(activeElement)
              if (!focusLeftPopover && anchor?.isConnected) anchor.focus()
            }}
          >
            <div className="space-y-1">
              <h2 id={titleId} className="text-sm font-semibold">{actionLabel}</h2>
              <p id={descriptionId} className="text-xs text-muted-foreground">
                Close now, or optionally classify this review for reporting.
              </p>
            </div>

            <div className="mt-3 grid gap-1.5">
              {reasons.filter((reason) => reason !== 'other').map((reason) => (
                <Button
                  key={reason}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-8 justify-start whitespace-normal px-2 py-1.5 text-left"
                  disabled={submitting}
                  onClick={() => submit({ reason, note: null })}
                >
                  {REASON_LABELS[reason]}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto min-h-8 justify-start px-2 py-1.5"
                disabled={submitting}
                onClick={() => {
                  setOtherSelected(true)
                  setValidationError(null)
                }}
              >
                Other…
              </Button>
            </div>

            {otherSelected ? (
              <div className="mt-3 space-y-2 border-t pt-3">
                <Label htmlFor={noteId}>Short note</Label>
                <Textarea
                  id={noteId}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={500}
                  rows={3}
                  disabled={submitting}
                  aria-invalid={Boolean(validationError)}
                  placeholder="Why did you close this review?"
                  autoFocus
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{note.length}/500</span>
                  <Button type="button" size="sm" disabled={submitting} onClick={submitOther}>
                    {submitting ? 'Saving…' : actionLabel}
                  </Button>
                </div>
              </div>
            ) : null}

            {validationError || error ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {validationError ?? error}
              </p>
            ) : null}

            <div className="mt-3 border-t pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-center text-muted-foreground"
                disabled={submitting}
                onClick={() => submit(null)}
              >
                {submitting ? 'Saving…' : 'Close without reason'}
              </Button>
            </div>
            <Popover.Arrow className="fill-popover" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Dialog
        open={open && Boolean(conflict)}
        onOpenChange={(next) => {
          if (!submitting) onOpenChange(next)
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Another operator updated this review</DialogTitle>
            <DialogDescription>
              Review the current decision before choosing whether to replace it.
            </DialogDescription>
          </DialogHeader>

          {conflict ? (
            <section
              className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
              aria-labelledby={`${replacementId}-heading`}
              role="alert"
            >
              <h3 id={`${replacementId}-heading`} className="text-sm font-semibold">
                Current decision
              </h3>
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
              <div className="border-t border-amber-500/30 pt-2 text-sm">
                <span className="font-medium">Your decision: </span>
                {proposedInput?.resolution
                  ? REASON_LABELS[proposedInput.resolution.reason]
                  : 'No reason'}
                {proposedInput?.resolution?.note ? ` — ${proposedInput.resolution.note}` : ''}
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-sm font-medium">
                <input
                  id={replacementId}
                  type="checkbox"
                  checked={replacementConfirmed}
                  onChange={(event) => setConfirmedConflictVersion(
                    event.target.checked ? conflict.version : null,
                  )}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span>I reviewed the current decision and want to replace it.</span>
              </label>
            </section>
          ) : null}

          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Keep current decision
            </Button>
            <Button
              onClick={() => proposedInput && void onSubmit(proposedInput)}
              disabled={submitting || !replacementConfirmed || !proposedInput}
            >
              {submitting ? 'Saving…' : 'Replace current decision'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export { REASON_LABELS }
