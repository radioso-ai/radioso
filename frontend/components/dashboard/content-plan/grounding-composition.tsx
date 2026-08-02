'use client'

import { cn } from '@/lib/utils'
import type {
  ContentPlanEvidenceStrength,
  ContentPlanHeadlineState,
  ContentPlanTopicGrounding,
} from '@/lib/api-content-plan'
import {
  evidenceSampleSentence,
  formatRatePercent,
  headlineStateAnnotation,
} from '@/lib/content-plan'

interface GroundingCompositionProps {
  grounding: ContentPlanTopicGrounding
  strength?: ContentPlanEvidenceStrength
  evaluatedConversationCount?: number
  /** Description id caller can point aria-describedby at, when embedding in a row. */
  descriptionId?: string
  /** Compact rendering for row use; false for full-width detail. */
  compact?: boolean
}

/**
 * Renders the three measured grounding verdicts as a segmented bar plus explicit
 * labels; `not_evaluated` appears next to it as an unmeasured annotation, never
 * inside the same bar. Every segment carries a text label so meaning is not
 * dependent on color, and the whole widget is a labelled group for screen
 * readers.
 */
export function GroundingComposition({
  grounding,
  strength,
  evaluatedConversationCount,
  descriptionId,
  compact = false,
}: GroundingCompositionProps) {
  const denominator = grounding.evaluatedAnswerCount
  const groundedPct = denominator === 0 ? 0 : grounding.groundedAnswerCount / denominator
  const degradedPct = denominator === 0 ? 0 : grounding.degradedAnswerCount / denominator
  const noSupportPct = denominator === 0 ? 0 : grounding.noSupportAnswerCount / denominator
  const notEvaluated = grounding.notEvaluatedAnswerCount
  const rateLabel = formatRatePercent(grounding.reducedOrNoSupportRate)
  const headline = grounding.headlineState

  return (
    <div className={cn('space-y-2', compact ? 'text-xs' : 'text-sm')} aria-describedby={descriptionId}>
      <div
        role="group"
        aria-label="Grounding composition of measured answers"
        className={cn(
          'flex overflow-hidden rounded-md border border-border bg-muted/40',
          compact ? 'h-2' : 'h-3',
        )}
      >
        <Segment
          label={`Grounded ${grounding.groundedAnswerCount}`}
          pct={groundedPct}
          tone="grounded"
        />
        <Segment
          label={`Degraded ${grounding.degradedAnswerCount}`}
          pct={degradedPct}
          tone="degraded"
        />
        <Segment
          label={`No support ${grounding.noSupportAnswerCount}`}
          pct={noSupportPct}
          tone="no_support"
        />
        {denominator === 0 ? (
          <div className="grow" aria-hidden />
        ) : null}
      </div>

      <ul className={cn('flex flex-wrap gap-x-3 gap-y-1', compact ? 'text-xs' : 'text-xs')}>
        <VerdictLegend label="Grounded" count={grounding.groundedAnswerCount} tone="grounded" />
        <VerdictLegend label="Degraded" count={grounding.degradedAnswerCount} tone="degraded" />
        <VerdictLegend label="No support" count={grounding.noSupportAnswerCount} tone="no_support" />
        {notEvaluated > 0 ? (
          <li
            className="inline-flex items-center gap-1.5 text-muted-foreground"
            data-not-evaluated
          >
            <span
              className="inline-block h-2 w-2 rounded-sm border border-dashed border-muted-foreground/70"
              aria-hidden
            />
            <span>
              <span className="font-medium tabular-nums">{notEvaluated}</span> not evaluated (separate)
            </span>
          </li>
        ) : null}
      </ul>

      <HeadlineNote
        headline={headline}
        rateLabel={rateLabel}
        denominator={denominator}
        degradedPlusNoSupport={grounding.degradedAnswerCount + grounding.noSupportAnswerCount}
        strength={strength}
        evaluatedConversationCount={evaluatedConversationCount}
        compact={compact}
      />
    </div>
  )
}

type Tone = 'grounded' | 'degraded' | 'no_support'

function segmentClass(tone: Tone): string {
  switch (tone) {
    case 'grounded':
      return 'bg-emerald-500'
    case 'degraded':
      return 'bg-amber-500'
    case 'no_support':
      return 'bg-destructive'
  }
}

function Segment({ label, pct, tone }: { label: string; pct: number; tone: Tone }) {
  if (pct <= 0) {
    return null
  }
  const width = `${(pct * 100).toFixed(2)}%`
  return (
    <div
      role="img"
      aria-label={label}
      className={cn('h-full', segmentClass(tone))}
      style={{ width }}
    />
  )
}

function VerdictLegend({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <li className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span
        className={cn('inline-block h-2 w-2 rounded-sm', segmentClass(tone))}
        aria-hidden
      />
      <span>
        <span className="font-medium text-foreground tabular-nums">{count}</span> {label.toLowerCase()}
      </span>
    </li>
  )
}

interface HeadlineNoteProps {
  headline: ContentPlanHeadlineState
  rateLabel: string | null
  denominator: number
  degradedPlusNoSupport: number
  strength?: ContentPlanEvidenceStrength
  evaluatedConversationCount?: number
  compact: boolean
}

function HeadlineNote({
  headline,
  rateLabel,
  denominator,
  degradedPlusNoSupport,
  strength,
  evaluatedConversationCount,
  compact,
}: HeadlineNoteProps) {
  const commonClass = cn(compact ? 'text-xs' : 'text-sm', 'text-muted-foreground')

  if (headline === 'measured' && rateLabel) {
    return (
      <p className={commonClass}>
        <span className="font-medium text-foreground">{rateLabel}</span>{' '}
        <span>reduced or no support of {denominator} measured answers.</span>{' '}
        {typeof evaluatedConversationCount === 'number' && strength ? (
          <span>{evidenceSampleSentence(evaluatedConversationCount, strength)}</span>
        ) : null}
      </p>
    )
  }

  if (headline === 'insufficient_measured_turns') {
    return (
      <p className={commonClass}>
        <span className="font-medium text-foreground">
          {degradedPlusNoSupport}/{denominator}
        </span>{' '}
        reduced or no support of {denominator} measured answers —{' '}
        {headlineStateAnnotation(headline).toLowerCase()}.
      </p>
    )
  }

  return <p className={commonClass}>{headlineStateAnnotation(headline)}.</p>
}
