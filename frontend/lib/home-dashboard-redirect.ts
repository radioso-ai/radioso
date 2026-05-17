import { buildDashboardHref } from '@/lib/dashboard-routes'

interface HomeDashboardRedirectWorkspace {
  id: string
  publicRouteKey: string
}

interface HomeDashboardRedirectInput {
  accountId: string | null | undefined
  isAuthBootstrapping: boolean
  isWorkspaceLoading: boolean
  activeWorkspace: HomeDashboardRedirectWorkspace | null | undefined
  agentId?: string | null
}

export const getHomeDashboardRedirectHref = ({
  accountId,
  isAuthBootstrapping,
  isWorkspaceLoading,
  activeWorkspace,
  agentId,
}: HomeDashboardRedirectInput): string | null => {
  if (isAuthBootstrapping || !accountId || isWorkspaceLoading || !activeWorkspace) {
    return null
  }

  return buildDashboardHref(accountId, {
    section: 'agents',
    workspaceId: activeWorkspace.id,
    workspacePublicRouteKey: activeWorkspace.publicRouteKey,
    agentId: agentId ?? undefined,
  })
}
