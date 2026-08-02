'use client'

import { AlertTriangle, Clock, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ContentPlanProjection } from '@/lib/api-content-plan'
import {
  formatProcessingLag,
  isProjectionQuietOk,
  projectionStateExplanation,
  projectionStateLabel,
} from '@/lib/content-plan'

interface ProcessingStripProps {
  projection: ContentPlanProjection
}

/**
 * Quiet freshness strip. When the projection is ready and nothing is pending
 * this component renders nothing so the page stays decision-first.
 */
export function ProcessingStrip({ projection }: ProcessingStripProps) {
  const anyPending =
    projection.pendingEmbeddingCount > 0
    || projection.pendingAssignmentCount > 0
    || projection.pendingEnrichmentTopicCount > 0
  if (isProjectionQuietOk(projection.state) && !anyPending) {
    return null
  }

  const isDegraded = projection.state === 'degraded' || projection.state === 'budget_paused'
  const Icon = isDegraded ? AlertTriangle : projection.state === 'bootstrapping' || projection.state === 'reprojecting' ? Clock : RefreshCw

  return (
    <aside
      className={cn(
        'rounded-md border px-3 py-2',
        isDegraded
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-border bg-muted/30',
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 text-sm">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', isDegraded ? 'text-destructive' : 'text-muted-foreground')} aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {projectionStateLabel(projection.state)} · {formatProcessingLag(projection.processingLagSeconds)}
          </p>
          <p className="text-muted-foreground">
            {projectionStateExplanation(projection.state)}
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {projection.pendingEmbeddingCount > 0 ? (
              <li>
                <span className="font-medium text-foreground tabular-nums">{projection.pendingEmbeddingCount}</span> awaiting embedding
              </li>
            ) : null}
            {projection.pendingAssignmentCount > 0 ? (
              <li>
                <span className="font-medium text-foreground tabular-nums">{projection.pendingAssignmentCount}</span> awaiting topic assignment
              </li>
            ) : null}
            {projection.pendingEnrichmentTopicCount > 0 ? (
              <li>
                <span className="font-medium text-foreground tabular-nums">{projection.pendingEnrichmentTopicCount}</span> topics enriching
              </li>
            ) : null}
            {projection.processedCount !== null && projection.totalCount !== null ? (
              <li>
                <span className="font-medium text-foreground tabular-nums">
                  {projection.processedCount}
                </span>
                {' / '}
                <span className="tabular-nums">{projection.totalCount}</span> processed
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </aside>
  )
}
