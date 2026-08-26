import type { DashboardQueryInvalidation } from '@/lib/dashboard-query-invalidation'
import type { WorkspaceEventsClient } from '@/lib/workspace-events-client'

export type DashboardLiveInterestSignal = 'ready' | 'retrying' | 'terminal'

export type DashboardLiveInterest = {
  open(input: {
    onInvalidation: (event: Extract<DashboardQueryInvalidation, { type: 'invalidate' | 'resync' }>) => void
    onLifecycle: (signal: DashboardLiveInterestSignal) => void
    workspaceId: string
  }): {
    close(): void | Promise<void>
  }
}

/** Adapts the browser transport to the dashboard's narrow live-interest port. */
export const createWorkspaceEventsInterest = (client: WorkspaceEventsClient): DashboardLiveInterest => ({
  open: ({ onInvalidation, onLifecycle }) => {
    let active = true
    let terminal = false
    const emitLifecycle = (signal: DashboardLiveInterestSignal) => {
      if (!active || terminal) return
      if (signal === 'terminal') terminal = true
      onLifecycle(signal)
    }
    const connection = client.connect({
      onState: () => undefined,
      onRetrying: () => emitLifecycle('retrying'),
      onReady: () => emitLifecycle('ready'),
      onInvalidate: (frame) => {
        if (active && !terminal) onInvalidation({ type: 'invalidate', kinds: frame.changeKinds })
      },
      onResync: () => {
        if (active && !terminal) onInvalidation({ type: 'resync' })
      },
      onTerminal: () => emitLifecycle('terminal'),
    })
    void connection.done.then(
      () => emitLifecycle('terminal'),
      () => emitLifecycle('terminal'),
    )
    return {
      close: () => {
        if (!active) return
        active = false
        return connection.close()
      },
    }
  },
})
