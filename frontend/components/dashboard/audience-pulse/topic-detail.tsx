'use client'

import type { ReactNode } from 'react'

import { answerStatusLabel, type AnswerStatus } from '@/lib/answer-coverage'
import type { AudiencePulseTheme, AudiencePulseThemeEvidence } from '@/lib/api-audience-pulse'
import { answerSplit, formatCount } from '@/lib/audience-pulse-figures'
import { cn } from '@/lib/utils'
import { questionLabel } from '@/lib/visitor-image-input'

import { AnswerSplitFigures, NO_ANSWER_FILL } from './answer-split-bar'

const EXAMPLE_LIMIT = 5

const STATUS_DOT: Record<AnswerStatus, string> = {
  answered: 'bg-chart-1',
  unanswered: NO_ANSWER_FILL,
  partial: 'bg-muted-foreground/60',
  unclear: 'bg-muted-foreground/60',
  out_of_scope: 'bg-muted-foreground/35',
  not_assessed: 'bg-muted-foreground/15',
}

function Example({
  evidence,
  onOpen,
}: {
  evidence: AudiencePulseThemeEvidence
  onOpen: (evidence: AudiencePulseThemeEvidence) => void
}) {
  return (
    <li>
      {/* The count and status sit inside the button so they are part of the example's accessible name. */}
      <button
        type="button"
        onClick={() => onOpen(evidence)}
        className="group flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-sm text-foreground underline-offset-2 group-hover:underline">
          “{questionLabel(evidence)}”
        </span>
        {evidence.occurrenceCount > 1 || evidence.answerStatus ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {evidence.occurrenceCount > 1 ? `asked ${formatCount(evidence.occurrenceCount)}×` : null}
            {evidence.occurrenceCount > 1 && evidence.answerStatus ? ' · ' : null}
            {evidence.answerStatus ? (
              <>
                <span className={cn('size-2 rounded-full', STATUS_DOT[evidence.answerStatus])} aria-hidden />
                {answerStatusLabel(evidence.answerStatus)}
              </>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  )
}

/** An expanded topic: what it is, how it was answered, a few of its questions, and Draft when it is in the queue. */
export function TopicDetail({
  id,
  theme,
  onOpenConversation,
  draftControl,
}: {
  id: string
  theme: AudiencePulseTheme
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
  draftControl: ReactNode
}) {
  const examples = theme.evidence.slice(0, EXAMPLE_LIMIT)
  return (
    <div id={id} className="grid gap-6 px-4 pb-5 pt-1 md:grid-cols-2 md:pl-10">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{theme.description}</p>
        {theme.answers ? (
          <AnswerSplitFigures
            parts={answerSplit(theme.answers, theme.grounding.contentGapEligible)}
            total={theme.memberCount}
          />
        ) : null}
      </div>
      <div className="space-y-3">
        {examples.length > 0 ? (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Examples</p>
            <ul className="-mx-2 space-y-0.5">
              {examples.map((evidence) => (
                <Example key={evidence.reference} evidence={evidence} onOpen={onOpenConversation} />
              ))}
            </ul>
          </div>
        ) : null}
        {draftControl ? <div>{draftControl}</div> : null}
      </div>
    </div>
  )
}
