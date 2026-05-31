'use client'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { UsageView } from '@/components/dashboard/usage-view'
import { UsersPanel } from '@/components/dashboard/users-view'
import { type DashboardRouteState } from '@/lib/dashboard-routes'

/** Content for the Account area: Members (team management) or Usage. */
export function AccountView({ routeState }: { routeState: DashboardRouteState }) {
  const tab = routeState.accountTab ?? 'members'

  if (tab === 'usage') {
    return <UsageView />
  }

  return (
    <DashboardPage title="Members" contentClassName="settings-surface min-h-0 flex-1 overflow-y-auto" contentScroll={false}>
      <div className="w-full p-6">
        <UsersPanel />
      </div>
    </DashboardPage>
  )
}
