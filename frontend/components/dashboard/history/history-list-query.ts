'use client'

import { useQuery, type QueryFunctionContext } from '@tanstack/react-query'

import { chatApi, type HistoryItemsResponse, type ChatHistoryListResponse, type ContactHistoryListResponse, type DocumentSearchHistoryListResponse } from '@/lib/api'
import { dashboardQueryKeys, type HistoryVariant } from '@/lib/dashboard-query-keys'
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

export const fetchHistory = async ({
  queryKey,
  signal,
}: QueryFunctionContext<ReturnType<typeof dashboardQueryKeys.history.list>>): Promise<HistoryListResponse> => {
  const workspaceId = String(queryKey[1])
  const variant = queryKey[4]
  const page = Number(queryKey[5])
  const pageSize = Number(queryKey[6])
  const input = { limit: pageSize, offset: (page - 1) * pageSize }
  if (variant === 'all') return { variant, response: await chatApi.listHistory(input, signal) }
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
}: {
  workspaceId?: string
  variant: HistoryVariant
  page: number
  pageSize: number
}) => {
  const policy = useDashboardQueryPolicy()
  const key = dashboardQueryKeys.history.list(workspaceId ?? '', { variant, page, pageSize })
  return useQuery({
    queryKey: key,
    queryFn: fetchHistory,
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(key),
  })
}
