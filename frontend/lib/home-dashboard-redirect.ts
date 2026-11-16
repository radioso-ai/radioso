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
  /**
   * 'agents' names the agent's Test chat tab explicitly — the only surface
   * first-run onboarding renders into (see dashboard-shell.tsx's
   * `isAgentChatView` / `showFirstRun`), because a bare agent link opens
   * Build. The caller passes this for a workspace that still needs onboarding. 'activity' (the Inbox) is the
   * normal landing section for every other authenticated entry — this is
   * the one call site `DEFAULT_SECTION` in dashboard-routes.ts doesn't
   * govern, since it always builds an explicit section rather than omitting
   * one.
   */
  section: 'agents' | 'activity'
  /** Only meaningful alongside `section: 'agents'` — ignored otherwise. */
  agentId?: string | null
}

export const getHomeDashboardRedirectHref = ({
  accountId,
  isAuthBootstrapping,
  isWorkspaceLoading,
  activeWorkspace,
  section,
  agentId,
}: HomeDashboardRedirectInput): string | null => {
  if (isAuthBootstrapping || !accountId || isWorkspaceLoading || !activeWorkspace) {
    return null
  }

  return buildDashboardHref(accountId, {
    section,
    workspaceId: activeWorkspace.id,
    workspacePublicRouteKey: activeWorkspace.publicRouteKey,
    ...(section === 'agents' ? { agentId: agentId ?? undefined, agentTab: 'chat' as const } : {}),
  })
}
