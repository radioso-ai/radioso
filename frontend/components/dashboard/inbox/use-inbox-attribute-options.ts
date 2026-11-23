'use client'

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { getApiErrorStatus } from '@/lib/api-error'
import { contextVariablesApi } from '@/lib/api-context-variables'
import { buildAttributeFilterChoices, type AttributeFilterChoice } from '@/lib/conversation-attributes'

export interface InboxAttributeOptions {
  /** The workspace's Choice attributes; empty until loaded, when not enabled, or for another workspace. */
  choices: AttributeFilterChoice[]
  /** The read failed for a reason other than the operator not being allowed to read attributes. */
  unavailable: boolean
  /** Reads the catalog again, such as after the list refused a filter whose attribute changed. */
  reload: () => void
}

interface Catalog {
  choices: AttributeFilterChoice[]
  unavailable: boolean
}

const NO_CHOICES: AttributeFilterChoice[] = []
// Attributes change rarely, so the Inbox filter and every open conversation share one read.
const CATALOG_STALE_TIME_MS = 60_000

const readCatalog = async (): Promise<Catalog> => {
  try {
    const response = await contextVariablesApi.listCatalog()
    return { choices: buildAttributeFilterChoices(response.contextVariables), unavailable: false }
  } catch (error) {
    // An operator who may not read attributes simply has no attribute filter.
    return { choices: NO_CHOICES, unavailable: getApiErrorStatus(error) !== 403 }
  }
}

/** The workspace's Choice attributes for the Inbox's attribute filter and the Attributes block, cached per workspace. */
export const useInboxAttributeOptions = ({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }): InboxAttributeOptions => {
  const policy = useDashboardQueryPolicy()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: dashboardQueryKeys.attributes.catalog(workspaceId),
    queryFn: readCatalog,
    enabled: enabled && Boolean(workspaceId) && policy.queriesEnabled,
    staleTime: CATALOG_STALE_TIME_MS,
    refetchInterval: false,
  })

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.attributes.catalog(workspaceId) })
  }, [queryClient, workspaceId])

  const current = enabled ? query.data : undefined
  return { choices: current?.choices ?? NO_CHOICES, unavailable: current?.unavailable ?? false, reload }
}
