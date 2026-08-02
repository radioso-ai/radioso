'use client'

import { ArrowRight, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  ContentPlanRecommendationAction,
  ContentPlanTopicSummary,
} from '@/lib/api-content-plan'
import {
  enrichmentStateLabel,
  evidenceSampleSentence,
  priorityReasonLabel,
  recommendationActionExplanation,
  recommendationActionLabel,
} from '@/lib/content-plan'

interface RecommendedNextCardProps {
  topic: ContentPlanTopicSummary
  primaryAction: {
    label: string
    onClick: () => void
    kind: 'primary' | 'outline'
    disabled?: boolean
  }
  onOpenTopic: () => void
}

/**
 * The single Recommended next card, sourced from the server's top-ranked
 * credible opportunity. Ordering, action selection, and priority reasons all
 * come from the backend; this component only renders the evidence and the
 * primary handoff.
 */
export function RecommendedNextCard({
  topic,
  primaryAction,
  onOpenTopic,
}: RecommendedNextCardProps) {
  const rec = topic.recommendation
  const action: ContentPlanRecommendationAction | null = rec.action
  const label = topic.label ?? 'Awaiting label'

  return (
    <section
      aria-labelledby="content-plan-recommended-next"
      className="rounded-xl border border-border bg-gradient-to-br from-primary/5 via-background to-background p-5"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary',
          )}
          aria-hidden
        >
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            Recommended next
          </p>
          <h2 id="content-plan-recommended-next" className="mt-1 text-lg font-semibold text-foreground">
            {label}
          </h2>
          {rec.state !== 'ready' ? (
            <Badge variant="outline" className="mt-2 border-border bg-background text-muted-foreground">
              Brief {enrichmentStateLabel(rec.state).toLowerCase()}
            </Badge>
          ) : null}
          {rec.rationale ? (
            <p className="mt-1 text-sm text-muted-foreground">{rec.rationale}</p>
          ) : topic.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{topic.description}</p>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatColumn label="Demand" value={`${topic.demand.currentQuestionCount} questions`} sub={`from ${topic.demand.currentConversationCount} conversations`} />
        <StatColumn
          label="Support evidence"
          value={
            topic.grounding.evaluatedAnswerCount === 0
              ? 'Unmeasured'
              : `${topic.grounding.degradedAnswerCount + topic.grounding.noSupportAnswerCount}/${topic.grounding.evaluatedAnswerCount} reduced/no support`
          }
          sub={evidenceSampleSentence(topic.evidence.evaluatedConversationCount, topic.evidence.strength)}
        />
        <StatColumn
          label="Action"
          value={recommendationActionLabel(action)}
          sub={rec.evidenceStatement ?? recommendationActionExplanation(action)}
        />
      </dl>

      {topic.opportunity.priorityReasons.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {topic.opportunity.priorityReasons.map((reason) => (
            <li key={reason}>
              <Badge variant="outline" className="border-primary/30 bg-primary/5 text-foreground">
                {priorityReasonLabel(reason)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {rec.questionsToAnswer.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            Questions the content should answer
          </p>
          <ul className="mt-2 space-y-1 text-sm text-foreground">
            {rec.questionsToAnswer.slice(0, 5).map((question, index) => (
              <li key={index} className="flex gap-2">
                <span aria-hidden className="mt-0.5 text-muted-foreground">•</span>
                <span>{question}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled}
          variant={primaryAction.kind === 'primary' ? 'default' : 'outline'}
          size="sm"
        >
          {primaryAction.label}
        </Button>
        <Button type="button" onClick={onOpenTopic} variant="ghost" size="sm">
          View topic detail
          <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Verify every fact against workspace-approved sources before publishing. Content plan does not invent business facts.
      </p>
    </section>
  )
}

function StatColumn({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{value}</dd>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}
