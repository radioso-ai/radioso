'use client'

import { useQuery, type QueryFunctionContext } from '@tanstack/react-query'

import { chatApi, type HistoryItemsResponse, type ChatHistoryListResponse, type ContactHistoryListResponse, type DocumentSearchHistoryListResponse } from '@/lib/api'
import { dashboardQueryKeys, type HistoryVariant } from '@/lib/dashboard-query-keys'
import type { ConversationSearchParams } from '@/lib/conversation-filters'
import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'

export type HistoryListResponse =
  | { variant: 'all'; response: HistoryItemsResponse }
  | { variant: 'chat'; response: ChatHistoryListResponse }
  | { variant: 'contact'; response: ContactHistoryListResponse }
  | { variant: 'search'; response: DocumentSearchHistoryListResponse }

export const shouldClampHistoryPage = (input: {
  activeVariant: HistoryVariant
  loadedVariant: HistoryVariant | undefined
  activePage: number
  totalPages: number
}) => input.loadedVariant === input.activeVariant && input.activePage > input.totalPages

/**
 * Whether the All lens's toolbar filter change (search/outcome/agent/site)
 * should reset pagination back to page 1. True only when the filter fingerprint
 * genuinely changed from what was last observed — not on a hook's first run,
 * where "last observed" is seeded with the current fingerprint (see the
 * caller): without that distinction, a deep link straight to page 2+ would
 * read as "the filter just changed" on mount and reset itself right back to
 * page 1 even though nothing changed. Also a no-op while already on page 1,
 * so it never fights the clamp effect above.
 */
export const shouldResetAllLensPageForFilterChange = (input: {
  activeVariant: HistoryVariant
  activePage: number
  previousServerSearchParamsFingerprint: string
  serverSearchParamsFingerprint: string
}): boolean => input.activeVariant === 'all'
  && input.activePage !== 1
  && input.previousServerSearchParamsFingerprint !== input.serverSearchParamsFingerprint

// Positional tail appended by dashboardQueryKeys.history.list only when `searchParams` was
// given (see its own comment) — [q, outcome, agentId, sourceOrigin], each optional(...)'d to
// `null` when absent. Read back here rather than threaded as a separate queryFn argument, so
// `fetchHistory` stays a plain `QueryFunctionContext` function (existing callers pass it
// directly as `queryFn: fetchHistory`).
const searchParamsFromKey = (queryKey: readonly unknown[]): ConversationSearchParams => ({
  ...(queryKey[7] ? { q: queryKey[7] as string } : {}),
  ...(queryKey[8] ? { outcome: queryKey[8] as ConversationSearchParams['outcome'] } : {}),
  ...(queryKey[9] ? { agentId: queryKey[9] as string } : {}),
  ...(queryKey[10] ? { sourceOrigin: queryKey[10] as string } : {}),
})

export const fetchHistory = async ({
  queryKey,
  signal,
}: QueryFunctionContext<ReturnType<typeof dashboardQueryKeys.history.list>>): Promise<HistoryListResponse> => {
  const workspaceId = String(queryKey[1])
  const variant = queryKey[4]
  const page = Number(queryKey[5])
  const pageSize = Number(queryKey[6])
  const input = { limit: pageSize, offset: (page - 1) * pageSize }
  if (variant === 'all') {
    return { variant, response: await chatApi.listHistory({ ...input, ...searchParamsFromKey(queryKey) }, signal) }
  }
  if (variant === 'chat') return { variant, response: await chatApi.listChatHistory(input, signal) }
  if (variant === 'contact') return { variant, response: await chatApi.listContactHistory(input, signal) }
  if (variant === 'search') return { variant, response: await chatApi.listSearchHistory(input, signal) }
  throw new Error(`Unsupported history variant for workspace ${workspaceId}`)
}

export const useHistoryListQuery = ({
  workspaceId,
  variant,
  page,
  pageSize,
  searchParams,
}: {
  workspaceId?: string
  variant: HistoryVariant
  page: number
  pageSize: number
  /** Only meaningful (and only sent) for variant 'all' — see dashboardQueryKeys.history.list. */
  searchParams?: ConversationSearchParams
}) => {
  const policy = useDashboardQueryPolicy()
  const key = dashboardQueryKeys.history.list(workspaceId ?? '', {
    variant,
    page,
    pageSize,
    searchParams: variant === 'all' ? searchParams : undefined,
  })
  return useQuery({
    queryKey: key,
    queryFn: fetchHistory,
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(key),
  })
}
