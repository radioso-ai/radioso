'use client'

import { type ReactNode, useMemo } from 'react'

import { DashboardQueryProvider } from '@/components/providers/dashboard-query-provider'
import { createWorkspaceEventsClient } from '@/lib/workspace-events-client'
import { createWorkspaceEventsInterest } from '@/lib/workspace-events-provider'

const browserClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs) as unknown as number,
  clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
}

export function WorkspaceEventsProvider({
  children,
  realtimeEnabled,
  workspaceId,
}: {
  children: ReactNode
  realtimeEnabled: boolean
  workspaceId: string
}) {
  const interest = useMemo(() => {
    if (!realtimeEnabled) return undefined
    return createWorkspaceEventsInterest(createWorkspaceEventsClient({
      workspaceId,
      fetch: globalThis.fetch.bind(globalThis),
      clock: browserClock,
      random: Math.random,
    }))
  }, [realtimeEnabled, workspaceId])

  return (
    <DashboardQueryProvider workspaceId={workspaceId} interest={interest}>
      {children}
    </DashboardQueryProvider>
  )
}
