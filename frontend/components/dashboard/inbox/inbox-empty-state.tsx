'use client'

import Link from 'next/link'

import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { RecentlyClosedInboxItem } from '@/lib/needs-attention'
import { InboxRecentlyClosedRow } from './inbox-queue-row'
import { useInboxConfidenceSummary } from './use-inbox-confidence-summary'

export interface InboxEmptyStateProps {
  recentlyClosed: RecentlyClosedInboxItem[]
  qualityReviewHref: string
  untriagedQualityCount: number | null
}

/**
 * The empty-open-queue state (FR-014): a confidence summary of recent
 * unassisted agent activity, the recently-closed strip, and a quiet link into
 * Quality review when there's an untriaged backlog — never a bare dead end.
 */
export function InboxEmptyState({ recentlyClosed, qualityReviewHref, untriagedQualityCount }: InboxEmptyStateProps) {
  const confidence = useInboxConfidenceSummary(true)
  const agentLabel = confidence.topAgent
    ? getAgentOperatorLabel(
        { internalName: confidence.topAgent.agentInternalName, name: confidence.topAgent.agentName },
        'Your agent',
      )
    : null

  return (
    <div className="flex h-full flex-col items-center gap-8 overflow-y-auto p-8 text-center">
      <div className="max-w-md space-y-2 pt-8">
        <p className="text-sm font-medium text-foreground">Nothing needs you right now</p>
        <p className="text-sm text-muted-foreground">
          {confidence.status === 'ready' && confidence.topAgent && agentLabel
            ? `${agentLabel} handled ${confidence.topAgent.count} conversation${confidence.topAgent.count === 1 ? '' : 's'} in the last 7 days without needing you.`
            : 'New handoffs, approvals, and written customer feedback will appear here.'}
        </p>
        {untriagedQualityCount !== null && untriagedQualityCount > 0 ? (
          <p className="text-sm">
            <Link
              href={qualityReviewHref}
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {untriagedQualityCount} answer{untriagedQualityCount === 1 ? '' : 's'} flagged for quality review
            </Link>
          </p>
        ) : null}
      </div>

      {recentlyClosed.length > 0 ? (
        <div className="w-full max-w-sm text-left">
          <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recently closed
          </p>
          <div className="flex flex-col gap-2">
            {recentlyClosed.map((item) => <InboxRecentlyClosedRow key={item.key} item={item} />)}
          </div>
        </div>
      ) : null}
    </div>
  )
}
