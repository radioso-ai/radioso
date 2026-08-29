'use client'

import Link from 'next/link'

import { getAgentOperatorLabel } from '@/lib/agent-label'
import { useInboxConfidenceSummary } from './use-inbox-confidence-summary'

export interface InboxEmptyStateProps {
  qualityReviewHref: string
  untriagedQualityCount: number | null
  /** The quality-turns queries came back 403 — the operator has no visibility into feedback signals at all. */
  qualityPermissionDenied: boolean
  /** The quality-turns queries failed to load (not a permission issue) — the count, if any, is not trustworthy. */
  qualityLoadFailed: boolean
}

/**
 * The confidence summary shown in place of the open-item rows when the queue
 * is empty (FR-014): recent unassisted agent activity, plus a quiet link into
 * Quality review when there's an untriaged backlog — never a bare dead end.
 * Renders inside the queue's own left pane (below the lens toggle, above the
 * recently-closed strip the queue renders itself) rather than replacing the
 * whole page, so the toggle and the All lens stay reachable with zero open
 * items (spec 1116 unification).
 *
 * Handoffs and approvals are always accurate here regardless of quality's
 * load state (they come from separate queries) — only the feedback-related
 * copy and the review-queue link are gated on `qualityPermissionDenied` /
 * `qualityLoadFailed`, so this surface never promises a feedback signal the
 * operator can't actually see.
 */
export function InboxEmptyState({
  qualityReviewHref,
  untriagedQualityCount,
  qualityPermissionDenied,
  qualityLoadFailed,
}: InboxEmptyStateProps) {
  const confidence = useInboxConfidenceSummary(true)
  const agentLabel = confidence.topAgent
    ? getAgentOperatorLabel(
        { internalName: confidence.topAgent.agentInternalName, name: confidence.topAgent.agentName },
        'Your agent',
      )
    : null
  const qualityUnavailable = qualityPermissionDenied || qualityLoadFailed

  return (
    <div className="space-y-2 px-1 py-3 text-center">
      <p className="text-sm font-medium text-foreground">Nothing needs you right now</p>
      <p className="text-sm text-muted-foreground">
        {confidence.status === 'ready' && confidence.topAgent && agentLabel
          ? `${agentLabel} handled ${confidence.topAgent.count} conversation${confidence.topAgent.count === 1 ? '' : 's'} in the last 7 days without needing you.`
          : qualityUnavailable
            ? 'New handoffs and approvals will appear here.'
            : 'New handoffs, approvals, and written customer feedback will appear here.'}
      </p>
      {qualityPermissionDenied ? (
        <p className="text-xs text-muted-foreground">
          You don&apos;t have permission to view quality feedback.
        </p>
      ) : qualityLoadFailed ? (
        <p className="text-xs text-muted-foreground">
          Quality feedback couldn&apos;t be loaded right now.
        </p>
      ) : untriagedQualityCount !== null && untriagedQualityCount > 0 ? (
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
  )
}
