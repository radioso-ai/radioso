'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  DashboardQueryInvalidationCoordinator,
} from '@/lib/dashboard-query-invalidation'
import type { DashboardLiveInterest, DashboardLiveInterestSignal } from '@/lib/workspace-events-provider'
import type { WorkspaceInvalidationKind } from '@radioso/workspace-invalidation-contract'

export type { DashboardLiveInterest, DashboardLiveInterestSignal } from '@/lib/workspace-events-provider'

export type DashboardQueryPolicy = {
  intervalFor(queryKey: readonly unknown[], knownActiveMs?: number): number
  liveInterestReady: boolean
  queriesEnabled: boolean
  visible: boolean
}

type DashboardLiveInterestLifecycleInput = {
  coordinator: DashboardQueryInvalidationCoordinator
  interest?: DashboardLiveInterest
  onReady(): void
  workspaceId: string
}

/**
 * Owns exactly one subscription attempt for a provider instance. It does not
 * schedule queries: it only establishes the subscribe-before-enable boundary.
 */
export class DashboardLiveInterestLifecycle {
  private generation = 0
  private activeGeneration: number | null = null
  private session: ReturnType<DashboardLiveInterest['open']> | null = null
  private scheduledGeneration: number | null = null
  private pollingReleased = false
  private terminal = false

  constructor(private readonly input: DashboardLiveInterestLifecycleInput) {}

  start(): void {
    if (this.activeGeneration !== null) return
    const generation = ++this.generation
    this.activeGeneration = generation
    this.scheduledGeneration = generation
    this.pollingReleased = false
    this.terminal = false
    queueMicrotask(() => this.beginAttempt(generation))
  }

  private beginAttempt(generation: number): void {
    if (generation !== this.generation || this.activeGeneration !== generation) return
    this.scheduledGeneration = null
    if (!this.input.interest) {
      this.handleLifecycle(generation, 'terminal')
      return
    }
    if (this.session) return
    let session: ReturnType<DashboardLiveInterest['open']>
    try {
      session = this.input.interest.open({
        workspaceId: this.input.workspaceId,
        onLifecycle: (signal) => this.handleLifecycle(generation, signal),
        onInvalidation: (event) => {
          if (generation === this.generation && !this.terminal) this.input.coordinator.process(event)
        },
      })
    } catch {
      this.handleLifecycle(generation, 'terminal')
      return
    }
    if (generation !== this.generation || this.activeGeneration !== generation) {
      void Promise.resolve(session.close()).catch(() => undefined)
      return
    }
    this.session = session
  }

  private handleLifecycle(generation: number, signal: DashboardLiveInterestSignal): void {
    if (generation !== this.generation || this.activeGeneration !== generation) return
    if (this.terminal) return

    if (signal === 'retrying') {
      // A reconnecting stream is acceleration only. Polling remains the
      // authoritative fallback while the same client retries in the background.
      this.releasePolling()
      return
    }

    if (signal === 'terminal') {
      this.terminal = true
      this.releasePolling()
      this.input.coordinator.process({ type: 'resync' })
      return
    }

    const reconnecting = this.pollingReleased
    this.releasePolling()
    this.input.coordinator.process(reconnecting ? { type: 'resync' } : { type: 'ready' })
  }

  private releasePolling(): void {
    if (this.pollingReleased) return
    this.pollingReleased = true
    this.input.onReady()
  }

  stop(): void {
    this.generation += 1
    this.activeGeneration = null
    this.scheduledGeneration = null
    this.pollingReleased = false
    this.terminal = false
    const session = this.session
    this.session = null
    if (!session) return
    void Promise.resolve(session.close()).catch(() => undefined)
  }
}

const DashboardQueryPolicyContext = createContext<DashboardQueryPolicy | null>(null)
const DashboardQueryInvalidationContext = createContext<((kinds: readonly WorkspaceInvalidationKind[]) => void) | null>(null)

export const isDashboardQueryRetryable = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
    return false
  }
  const status = typeof error === 'object' && error && 'status' in error
    ? (error as { status?: number }).status
    : undefined
  return status !== 401 && status !== 403
}

export const dashboardQueryJitterMs = (queryKey: readonly unknown[]) => {
  const text = JSON.stringify(queryKey)
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return 45_000 + (Math.abs(hash) % 15_001)
}

export const dashboardQueryIntervalMs = (queryKey: readonly unknown[], knownActiveMs?: number) =>
  knownActiveMs === undefined
    ? dashboardQueryJitterMs(queryKey)
    : Math.min(knownActiveMs, dashboardQueryJitterMs(queryKey))

export const createDashboardQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: (attempt, error) => isDashboardQueryRetryable(error) && attempt < 2,
      refetchInterval: (query) => dashboardQueryJitterMs(query.queryKey),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchIntervalInBackground: false,
    },
  },
})

export const useDashboardQueryPolicy = () => {
  const policy = useContext(DashboardQueryPolicyContext)
  if (!policy) throw new Error('Dashboard queries must be rendered inside DashboardQueryProvider.')
  return policy
}

/** Domain views supply only contract kinds; the provider owns exact query mapping. */
export const useDashboardQueryInvalidation = () => {
  const invalidate = useContext(DashboardQueryInvalidationContext)
  if (!invalidate) throw new Error('Dashboard invalidation must be rendered inside DashboardQueryProvider.')
  return invalidate
}

const isDocumentVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

export function DashboardQueryProvider({
  children,
  interest,
  workspaceId,
}: {
  children: ReactNode
  interest?: DashboardLiveInterest
  workspaceId: string
}) {
  const client = useMemo(() => {
    const nextClient = createDashboardQueryClient()
    // Mark the client as workspace-scoped as well as recreating it on a switch.
    nextClient.setQueryDefaults(['workspace', workspaceId], {})
    return nextClient
  }, [workspaceId])
  const coordinator = useMemo(
    () => new DashboardQueryInvalidationCoordinator({ queryClient: client, workspaceId }),
    [client, workspaceId],
  )
  const [visible, setVisible] = useState(isDocumentVisible)
  const [readyLifecycle, setReadyLifecycle] = useState<DashboardLiveInterestLifecycle | null>(null)
  const lifecycle = useMemo(() => {
    const nextLifecycle = new DashboardLiveInterestLifecycle({
      coordinator,
      interest,
      workspaceId,
      onReady: () => setReadyLifecycle(nextLifecycle),
    })
    return nextLifecycle
  }, [coordinator, interest, workspaceId])
  const liveInterestReady = readyLifecycle === lifecycle

  useEffect(() => coordinator.subscribe(), [coordinator])

  useEffect(() => {
    const onVisibilityChange = () => {
      const nextVisible = isDocumentVisible()
      setVisible(nextVisible)
      coordinator.setVisible(nextVisible)
      if (!nextVisible) {
        setReadyLifecycle(null)
        void client.cancelQueries({ queryKey: ['workspace', workspaceId] })
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [client, coordinator, workspaceId])

  useEffect(() => {
    if (!visible) return
    lifecycle.start()
    return () => lifecycle.stop()
  }, [lifecycle, visible])

  useEffect(() => () => {
    void client.cancelQueries({ queryKey: ['workspace', workspaceId] })
    client.clear()
  }, [client, workspaceId])

  const policy = useMemo<DashboardQueryPolicy>(() => ({
    visible,
    liveInterestReady,
    queriesEnabled: visible && liveInterestReady,
    intervalFor: dashboardQueryIntervalMs,
  }), [liveInterestReady, visible])
  const invalidate = useMemo(() => (kinds: readonly WorkspaceInvalidationKind[]) => {
    coordinator.invalidate(kinds)
  }, [coordinator])

  return (
    <QueryClientProvider client={client} key={workspaceId}>
      <DashboardQueryInvalidationContext.Provider value={invalidate}>
        <DashboardQueryPolicyContext.Provider value={policy}>
          {children}
        </DashboardQueryPolicyContext.Provider>
      </DashboardQueryInvalidationContext.Provider>
    </QueryClientProvider>
  )
}
