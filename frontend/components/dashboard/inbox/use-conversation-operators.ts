'use client'

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { hitlApi } from '@/lib/api-hitl'
import type { ConversationOperator } from '@/lib/api-types'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'

const NO_OPERATORS: ConversationOperator[] = []
// Teammates change rarely, so switching lenses or items reuses the cached list.
const OPERATORS_STALE_TIME_MS = 60_000

/**
 * The workspace's teammates who can own a conversation, for the response
 * view's "Hand to…" menu. Cached per workspace and read again on `refresh` —
 * after a transfer finds its target no longer eligible. A failed read leaves
 * the menu out rather than blocking the composer.
 */
export const useConversationOperators = (
  workspaceId: string,
  enabled: boolean,
): { operators: ConversationOperator[]; refresh: () => void } => {
  const policy = useDashboardQueryPolicy()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: dashboardQueryKeys.conversations.operators(workspaceId),
    queryFn: ({ signal }) => hitlApi.listConversationOperators(signal),
    enabled: enabled && Boolean(workspaceId) && policy.queriesEnabled,
    staleTime: OPERATORS_STALE_TIME_MS,
    refetchInterval: false,
  })

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.conversations.operators(workspaceId) })
  }, [queryClient, workspaceId])

  return { operators: query.data?.operators ?? NO_OPERATORS, refresh }
}
