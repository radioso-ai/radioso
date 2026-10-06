'use client'

import { useQuery } from '@tanstack/react-query'

import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { hitlApi } from '@/lib/api-hitl'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { buildRecentlyClosedItems, RECENTLY_CLOSED_LIMIT } from '@/lib/needs-attention'

/**
 * The Inbox's recently closed items — handoffs handed back, approvals decided, negative feedback
 * resolved or dismissed — each with the teammate who closed it. Refreshed by the same workspace
 * events that close them (see `matchesWorkspaceInvalidation`).
 */
export const useInboxRecentlyClosed = (workspaceId: string) => {
  const policy = useDashboardQueryPolicy()
  const queryKey = dashboardQueryKeys.attention.recentlyClosed(workspaceId, { limit: RECENTLY_CLOSED_LIMIT })
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => hitlApi.listRecentlyClosed({ limit: RECENTLY_CLOSED_LIMIT }, signal),
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(queryKey),
  })
  return {
    items: buildRecentlyClosedItems(query.data?.items ?? []),
    isLoading: query.isLoading,
    hasLoadFailure: query.isError,
  }
}
