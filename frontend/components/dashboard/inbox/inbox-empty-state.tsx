'use client'

import Link from 'next/link'

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
 * The confidence summary shown in the reading pane in place of the "select an
 * item" prompt when the queue has zero open items (FR-014): recent
 * unassisted agent activity, plus a quiet link into Quality review when
 * there's an untriaged backlog — never a bare dead end. Rendered by
 * `InboxResponseView`'s `emptyPlaceholder`, centered in the reading pane,
 * rather than in the queue's own (now filter-less, row-less) left pane, so
 * the toggle and the All lens stay reachable with zero open items and the
 * message reads as an answer to "what's the state of my inbox" rather than
 * unreachable advice (spec 1116 unification).
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
  const hasHandledConversations = confidence.status === 'ready'
    && confidence.totalCount !== null
    && confidence.totalCount > 0
  const qualityUnavailable = qualityPermissionDenied || qualityLoadFailed

  return (
    <div className="mx-auto max-w-md space-y-2 text-center">
      <p className="text-sm font-medium text-foreground">Nothing needs you right now</p>
      <p className="text-sm text-muted-foreground">
        {hasHandledConversations
          ? `Your agent${confidence.agentCount === 1 ? '' : 's'} handled ${confidence.totalCount} conversation${confidence.totalCount === 1 ? '' : 's'} in the last 7 days without needing you.`
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
