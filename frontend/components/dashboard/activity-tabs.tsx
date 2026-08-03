import {
  buildDashboardHref,
  type ActivityTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'

/**
 * Builds hrefs for the Activity surfaces (Needs attention / All activity / Quality /
 * Audience Pulse), which now live as nested items in the sidebar rather than in-page
 * tabs. Quality and Audience Pulse are both variants of the `quality` section, so the
 * rail highlight stays on Activity while the view switches.
 */
export type ActivitySurfaceTab = ActivityTab | 'quality' | 'audience-pulse'

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
    if (targetTab === 'quality' || targetTab === 'audience-pulse') {
      return buildDashboardHref(accountId, {
        ...routeState,
        section: 'quality',
        activityTab: undefined,
        qualityView: targetTab === 'audience-pulse' ? 'audience-pulse' : undefined,
      })
    }
    return buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      activityTab: targetTab,
    })
  }

  if (targetTab === 'quality' || targetTab === 'audience-pulse') {
    return buildDashboardHref(accountId, {
      section: 'quality',
      ...workspaceState,
      qualityView: targetTab === 'audience-pulse' ? 'audience-pulse' : undefined,
    })
  }

  return buildDashboardHref(accountId, {
    section: 'activity',
    ...workspaceState,
    activityTab: targetTab,
  })
}
