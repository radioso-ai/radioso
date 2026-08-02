import {
  buildDashboardHref,
  type ActivityTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'

/**
 * Builds hrefs for the Activity surfaces (Needs attention / All activity /
 * Content plan / Quality), which live as nested items in the sidebar rather than
 * in-page tabs. Quality and Content plan are separate sections; the other two
 * are activity tabs.
 */
export type ActivitySurfaceTab = ActivityTab | 'quality' | 'content-plan'

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
    if (targetTab === 'quality' || targetTab === 'content-plan') {
      return buildDashboardHref(accountId, {
        ...routeState,
        section: targetTab,
        activityTab: undefined,
      })
    }
    return buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      activityTab: targetTab,
    })
  }

  if (targetTab === 'quality') {
    return buildDashboardHref(accountId, {
      section: 'quality',
      ...workspaceState,
    })
  }

  if (targetTab === 'content-plan') {
    return buildDashboardHref(accountId, {
      section: 'content-plan',
      ...workspaceState,
    })
  }

  return buildDashboardHref(accountId, {
    section: 'activity',
    ...workspaceState,
    activityTab: targetTab,
  })
}
