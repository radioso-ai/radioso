'use client'

import { useRouter } from 'next/navigation'

import { buildActivityTabHref } from '@/components/dashboard/activity-tabs'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { ActivityTab, DashboardRouteState } from '@/lib/dashboard-routes'

/**
 * "One shell, two lenses" (spec 1116 unification): the segmented control at
 * the top of the Inbox page's left pane, switching between the Needs-you
 * queue and the All conversations log. Both lenses render this same control
 * (each hosting its own list pane), rather than a shared parent owning it, so
 * the Needs-you lens stays otherwise untouched. `needsYouCount` always comes
 * from the client inbox model (see `useNeedsAttentionOpenCount`), so the
 * label agrees with the Needs-you lens's own queue regardless of which lens
 * rendered the control.
 */
export function InboxLensToggle({
  accountId,
  routeState,
  activeTab,
  needsYouCount,
}: {
  accountId: string
  routeState: DashboardRouteState
  activeTab: ActivityTab
  needsYouCount: number
}) {
  const router = useRouter()

  return (
    <SegmentedControl
      value={activeTab}
      onValueChange={(next) => router.push(buildActivityTabHref(accountId, routeState, activeTab, next))}
      options={[
        { value: 'needs-attention', label: `Needs you · ${needsYouCount}` },
        { value: 'all', label: 'All' },
      ]}
      aria-label="Inbox lens"
    />
  )
}
