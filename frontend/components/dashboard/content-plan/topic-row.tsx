'use client'

import { ArrowRight, ArrowUpRight, Minus, Sparkles, TrendingDown, TrendingUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type {
  ContentPlanTopicSummary,
  ContentPlanTrend,
} from '@/lib/api-content-plan'
import {
  enrichmentStateLabel,
  evidenceStrengthLabel,
  priorityReasonLabel,
  recommendationActionLabel,
  trendLabel,
} from '@/lib/content-plan'
import { GroundingComposition } from './grounding-composition'

interface TopicRowProps {
  topic: ContentPlanTopicSummary
  selected: boolean
  isRecommended: boolean
  onSelect: (topicId: string) => void
  registerRef?: (node: HTMLButtonElement | null) => void
}

/**
 * A ranked-list row. The row is a single button so keyboard and screen-reader
 * users get one activatable target. Grounding composition renders inline with
 * text labels so meaning is not conveyed solely by color.
 */
export function TopicRow({ topic, selected, isRecommended, onSelect, registerRef }: TopicRowProps) {
  const groundingDescriptionId = `topic-${topic.id}-grounding`

  return (
    <button
      type="button"
      ref={(node) => registerRef?.(node)}
      onClick={() => onSelect(topic.id)}
      aria-pressed={selected}
      data-content-plan-topic-id={topic.id}
      data-content-plan-topic-row
      className={cn(
        'group flex w-full flex-col gap-3 rounded-lg border p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border bg-background hover:border-primary/50 hover:bg-accent/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {isRecommended ? (
              <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                <Sparkles className="h-3 w-3" aria-hidden /> Recommended
              </Badge>
            ) : null}
            <h3 className="text-base font-semibold text-foreground">
              {topic.label ?? 'Awaiting label'}
            </h3>
          </div>
          {topic.description ? (
            <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
              {topic.description}
            </p>
          ) : null}
        </div>
        <ArrowRight
          aria-hidden
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            selected ? 'translate-x-0 text-primary' : 'group-hover:translate-x-0.5',
          )}
        />
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-normal text-muted-foreground">Demand</dt>
          <dd className="mt-0.5 text-sm text-foreground">
            <span className="font-semibold tabular-nums">{topic.demand.currentQuestionCount}</span> questions
            <span className="text-muted-foreground">
              {' · '}
              {topic.demand.currentConversationCount} conversation{topic.demand.currentConversationCount === 1 ? '' : 's'}
            </span>
          </dd>
          <TrendPill trend={topic.demand.trend} absoluteChange={topic.demand.absoluteChange} />
        </div>

        <div>
          <dt className="text-xs uppercase tracking-normal text-muted-foreground">Support evidence</dt>
          <dd className="mt-0.5" id={groundingDescriptionId}>
            <GroundingComposition
              grounding={topic.grounding}
              strength={topic.evidence.strength}
              evaluatedConversationCount={topic.evidence.evaluatedConversationCount}
              compact
            />
          </dd>
        </div>

        <div>
          <dt className="text-xs uppercase tracking-normal text-muted-foreground">Recommendation</dt>
          <dd className="mt-0.5 text-sm text-foreground">
            {recommendationActionLabel(topic.recommendation.action)}
          </dd>
          <p className="text-xs text-muted-foreground">
            {evidenceStrengthLabel(topic.evidence.strength)} · Brief{' '}
            {enrichmentStateLabel(topic.recommendation.state).toLowerCase()}
          </p>
          {topic.opportunity.priorityReasons.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {topic.opportunity.priorityReasons.slice(0, 3).map((reason) => (
                <li key={reason}>
                  <Badge variant="outline" className="border-border bg-background text-muted-foreground">
                    {priorityReasonLabel(reason)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </dl>
    </button>
  )
}

function TrendPill({ trend, absoluteChange }: { trend: ContentPlanTrend; absoluteChange: number }) {
  const Icon =
    trend === 'rising' || trend === 'new'
      ? TrendingUp
      : trend === 'falling'
        ? TrendingDown
        : trend === 'insufficient_data'
          ? ArrowUpRight
          : Minus
  return (
    <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="h-3 w-3" />
      <span>
        {trendLabel(trend)}
        {trend !== 'insufficient_data' && absoluteChange !== 0 ? (
          <span className="tabular-nums">
            {' '}
            ({absoluteChange > 0 ? '+' : ''}
            {absoluteChange})
          </span>
        ) : null}
      </span>
    </p>
  )
}
