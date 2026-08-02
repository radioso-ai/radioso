'use client'

import type { ReactNode } from 'react'

import type { ContentPlanSummary } from '@/lib/api-content-plan'
import { formatRatePercent, headlineStateAnnotation } from '@/lib/content-plan'
import { cn } from '@/lib/utils'

interface SummaryTilesProps {
  summary: ContentPlanSummary
}

/**
 * Four summary tiles at the top of Content plan. The reduced/no-support tile is
 * responsibility-limited: below medium evidence it never shows a percentage-only
 * headline; instead it exposes raw counts and the honest denominator state.
 */
export function SummaryTiles({ summary }: SummaryTilesProps) {
  const rate = formatRatePercent(summary.grounding.reducedOrNoSupportRate)
  const denominator = summary.grounding.evaluatedAnswerCount
  const headline = summary.grounding.headlineState
  const showPercent = headline === 'measured' && rate !== null

  return (
    <ul
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      aria-label="Content plan summary"
    >
      <Tile
        label="Visitor questions"
        value={summary.questionCount}
        supporting={`${summary.conversationCount} distinct conversation${
          summary.conversationCount === 1 ? '' : 's'
        }`}
      />
      <Tile
        label="Mature topics"
        value={summary.matureTopicCount}
        supporting={`${summary.emergingQuestionCount} emerging`}
      />
      <Tile
        label="Content opportunities"
        value={summary.opportunityCount}
        supporting={summary.opportunityCount === 0 ? 'No credible content gaps right now' : 'Ranked by active evidence'}
      />
      <Tile
        label="Reduced or no support"
        value={
          showPercent ? (
            <span className="tabular-nums">{rate}</span>
          ) : (
            <span className="tabular-nums text-2xl">
              {summary.grounding.degradedAnswerCount + summary.grounding.noSupportAnswerCount}
              <span className="text-base text-muted-foreground">/{denominator}</span>
            </span>
          )
        }
        supporting={
          showPercent
            ? `${summary.grounding.degradedAnswerCount + summary.grounding.noSupportAnswerCount} of ${denominator} measured answers`
            : headlineStateAnnotation(headline)
        }
      />
    </ul>
  )
}

interface TileProps {
  label: string
  value: ReactNode | number
  supporting: ReactNode
}

function Tile({ label, value, supporting }: TileProps) {
  return (
    <li className={cn('rounded-lg border border-border bg-card p-4')}>
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-foreground">
        {typeof value === 'number' ? <span className="tabular-nums">{value}</span> : value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{supporting}</p>
    </li>
  )
}
