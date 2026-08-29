import {
  buildDashboardHref,
  type ActivityTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'

/**
 * Builds hrefs for the Inbox page's lens toggle (Needs you / All — spec 1116's
 * "one shell, two lenses" unification). Clicking the already-active lens
 * preserves whatever filters/deep-link state the operator has open; switching
 * lenses resets to a fresh view of the target lens so state from one surface
 * never leaks into the other.
 */
export function buildActivityTabHref(
  accountId: string,
  routeState: DashboardRouteState,
  activeTab: ActivityTab,
  targetTab: ActivityTab,
) {
  if (targetTab === activeTab) {
    return buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      activityTab: targetTab,
    })
  }

  return buildDashboardHref(accountId, {
    section: 'activity',
    workspaceId: routeState.workspaceId,
    workspacePublicRouteKey: routeState.workspacePublicRouteKey,
    activityTab: targetTab,
  })
}

/**
 * Builds hrefs for the Quality sidebar's two nested items (Review / Evals). Review is
 * the `quality` section's triage queue; Evals is the separate `eval` section. Clicking
 * the already-active tab preserves its filters/deep-link state; switching tabs resets
 * to a fresh view so state from one surface never leaks into the other.
 */
export type QualitySurfaceTab = 'review' | 'evals'

export function buildQualityTabHref(
  accountId: string,
  routeState: DashboardRouteState,
  activeTab: QualitySurfaceTab,
  targetTab: QualitySurfaceTab,
) {
  const targetSection = targetTab === 'evals' ? 'eval' : 'quality'

  if (targetTab === activeTab) {
    return buildDashboardHref(accountId, { ...routeState, section: targetSection })
  }

  return buildDashboardHref(accountId, {
    section: targetSection,
    workspaceId: routeState.workspaceId,
    workspacePublicRouteKey: routeState.workspacePublicRouteKey,
  })
}
