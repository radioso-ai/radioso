'use client'

import { HelpCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ContentPlanEmergingQuestion } from '@/lib/api-content-plan'

interface EmergingSectionProps {
  items: readonly ContentPlanEmergingQuestion[]
}

const stateLabel: Record<ContentPlanEmergingQuestion['state'], string> = {
  emerging: 'Emerging',
  awaiting_context: 'Awaiting conversation context',
  awaiting_embedding: 'Awaiting embedding',
}

/**
 * Emerging questions are visible but quieter than mature topics. No generated
 * label, action, or brief is shown; the display uses the observation identity
 * and a typed state so nothing looks like a finished recommendation.
 */
export function EmergingSection({ items }: EmergingSectionProps) {
  if (items.length === 0) {
    return null
  }

  return (
    <section aria-labelledby="content-plan-emerging" className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-muted-foreground">
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        <h2 id="content-plan-emerging">Emerging evidence</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Recent visitor questions that have not yet clustered into a mature topic. They receive
        no recommendation and no generated label until the maturity threshold is met.
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.observationId}
            className={cn(
              'rounded-md border border-dashed border-border bg-muted/20 p-3 text-sm text-foreground',
            )}
          >
            <p className="line-clamp-2">
              {item.sourceAvailable && item.question
                ? item.question
                : '(Source question is no longer available.)'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              <span>{stateLabel[item.state]}</span>
              <span aria-hidden> · </span>
              <span>
                {item.questionCount} question{item.questionCount === 1 ? '' : 's'} across{' '}
                {item.conversationCount} conversation{item.conversationCount === 1 ? '' : 's'}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
