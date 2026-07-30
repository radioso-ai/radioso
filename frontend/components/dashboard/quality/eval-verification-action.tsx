'use client'

import { FlaskConical, SquareArrowOutUpRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { QualityVerification } from '@/lib/api-quality'

const STATUS_LABEL = {
  pending: 'Pending',
  passing: 'Passing',
  failing: 'Failing',
  error: 'Error',
} as const

const formatEvidenceTime = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function EvalVerificationAction({
  verification,
  pending,
  onOpen,
  onReviewAndResolve,
}: {
  verification: QualityVerification | null
  pending: boolean
  onOpen: () => void
  onReviewAndResolve: () => void
}) {
  const passedAt = verification?.latestRunStatus === 'pass'
    ? verification.latestRunAt
    : null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onOpen()
        }}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-primary hover:text-primary/80 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={verification ? `Open Eval, ${STATUS_LABEL[verification.caseStatus]}` : 'Add to Eval'}
      >
        {verification ? (
          <SquareArrowOutUpRight className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <FlaskConical className="h-3.5 w-3.5" aria-hidden />
        )}
        {pending
          ? 'Opening Eval…'
          : verification
            ? `Open Eval · ${STATUS_LABEL[verification.caseStatus]}`
            : 'Add to Eval'}
      </button>
      {passedAt ? (
        <>
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            Eval passed · {formatEvidenceTime(passedAt)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation()
              onReviewAndResolve()
            }}
          >
            Review and resolve
          </Button>
        </>
      ) : null}
    </div>
  )
}
