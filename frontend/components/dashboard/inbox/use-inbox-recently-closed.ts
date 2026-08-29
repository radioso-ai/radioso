'use client'

import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { buildRecentlyClosedFeedbackItems, RECENTLY_CLOSED_FEEDBACK_LIMIT, type RecentlyClosedInboxItem } from '@/lib/needs-attention'
import { useQualityTurnsQuery, type QualityTurnsRequest } from '@/lib/quality-query-state'

/**
 * Recently-closed feedback (spec 1116's floor for the recently-closed strip:
 * handoff/approval closures have no durable record yet). The server's default
 * sort is already newest-first by turn creation, which is a reasonable proxy
 * here — `buildRecentlyClosedFeedbackItems` re-sorts by actual closure time.
 */
export const recentlyClosedFeedbackInput: QualityTurnsRequest = {
  triageStates: ['resolved', 'dismissed'],
  page: 1,
  pageSize: RECENTLY_CLOSED_FEEDBACK_LIMIT,
}

export const useInboxRecentlyClosed = (workspaceId: string): RecentlyClosedInboxItem[] => {
  const policy = useDashboardQueryPolicy()
  const queryKey = dashboardQueryKeys.quality.turns(workspaceId, recentlyClosedFeedbackInput)
  const query = useQualityTurnsQuery(
    workspaceId,
    recentlyClosedFeedbackInput,
    policy.queriesEnabled,
    policy.intervalFor(queryKey),
  )
  return buildRecentlyClosedFeedbackItems(query.data?.items ?? [])
}
