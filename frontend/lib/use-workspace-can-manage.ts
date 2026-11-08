'use client'

import { useQuery } from '@tanstack/react-query'

import { apiAccessApi } from '@/lib/api-api-access'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * Whether the signed-in teammate manages the active workspace: an owner or admin there, by account
 * role or workspace grant. `roleKnown` is false until the server has answered, so a surface can wait
 * before telling a teammate what they may not do.
 */
export function useWorkspaceCanManage(): { canManage: boolean; roleKnown: boolean } {
  const { activeWorkspaceId } = useWorkspace()
  const workspaceAccess = useQuery({
    queryKey: ['workspace-effective-role', activeWorkspaceId],
    queryFn: () => apiAccessApi.getSummary(activeWorkspaceId ?? ''),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 60_000,
  })
  const effectiveRole = workspaceAccess.data?.effectiveRole
  return {
    canManage: effectiveRole === 'owner' || effectiveRole === 'admin',
    roleKnown: workspaceAccess.isSuccess,
  }
}
