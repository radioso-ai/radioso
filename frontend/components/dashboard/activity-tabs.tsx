import {
  buildDashboardHref,
  type ActivityTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'

/**
 * Builds hrefs for the Activity surfaces (Needs attention / All activity / Quality),
 * which now live as nested items in the sidebar rather than in-page tabs. Quality is a
 * separate section; the other two are activity tabs.
 */
export type ActivitySurfaceTab = ActivityTab | 'quality'

export function buildActivityTabHref(
  accountId: string,
  routeState: DashboardRouteState,
  activeTab: ActivitySurfaceTab,
  targetTab: ActivitySurfaceTab,
) {
  const workspaceState = {
    workspaceId: routeState.workspaceId,
    workspacePublicRouteKey: routeState.workspacePublicRouteKey,
  }

  if (targetTab === activeTab) {
    return buildDashboardHref(accountId, {
      ...routeState,
      section: targetTab === 'quality' ? 'quality' : 'activity',
      activityTab: targetTab === 'quality' ? undefined : targetTab,
    })
  }

  if (targetTab === 'quality') {
    return buildDashboardHref(accountId, {
      section: 'quality',
      ...workspaceState,
    })
  }

  return buildDashboardHref(accountId, {
    section: 'activity',
    ...workspaceState,
    activityTab: targetTab,
  })
}
