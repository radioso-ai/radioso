'use client'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { CopilotChatSurface } from './copilot-chat-surface'
import type { CopilotAvailability } from '@/lib/api-copilot'
import { type DashboardRouteState } from '@/lib/dashboard-routes'

export function CopilotView({
  accountId,
  routeState,
  availability,
}: {
  accountId: string
  routeState: DashboardRouteState
  availability: CopilotAvailability | null
}) {
  return (
    <DashboardPage
      title="Copilot"
      description="Investigate agent behavior from the dashboard."
      contentClassName="relative flex min-h-0 flex-col p-0"
      contentScroll={false}
    >
      <CopilotChatSurface accountId={accountId} routeState={routeState} initialAvailability={availability} mode="page" />
    </DashboardPage>
  )
}
