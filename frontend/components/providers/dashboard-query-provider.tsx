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
  type DashboardQueryInvalidation,
} from '@/lib/dashboard-query-invalidation'
import type { WorkspaceInvalidationKind } from '@radioso/workspace-invalidation-contract'

export type DashboardLiveInterestOutcome = 'ready' | 'terminal'

/** Phase 4 supplies the real stream adapter; this is deliberately its only UI seam. */
export type DashboardLiveInterest = {
  open(input: {
    onInvalidation: (event: Extract<DashboardQueryInvalidation, { type: 'invalidate' | 'resync' }>) => void
    workspaceId: string
  }): {
    close(): void | Promise<void>
    outcome: Promise<DashboardLiveInterestOutcome>
  }
}

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

  constructor(private readonly input: DashboardLiveInterestLifecycleInput) {}

  start(): void {
    if (this.activeGeneration !== null) return
    const generation = ++this.generation
    this.activeGeneration = generation
    this.scheduledGeneration = generation
    queueMicrotask(() => this.beginAttempt(generation))
  }

  private beginAttempt(generation: number): void {
    if (generation !== this.generation || this.activeGeneration !== generation) return
    this.scheduledGeneration = null
    if (!this.input.interest) {
      this.settleTerminal(generation)
      return
    }
    if (this.session) return
    let session: ReturnType<DashboardLiveInterest['open']>
    try {
      session = this.input.interest.open({
        workspaceId: this.input.workspaceId,
        onInvalidation: (event) => {
          if (generation === this.generation) this.input.coordinator.process(event)
        },
      })
    } catch {
      this.settleTerminal(generation)
      return
    }
    this.session = session
    void session.outcome.then((outcome) => {
      if (generation !== this.generation || this.activeGeneration !== generation || this.session !== session) return
      this.input.onReady()
      this.input.coordinator.process(outcome === 'ready' ? { type: 'ready' } : { type: 'resync' })
    }).catch(() => {
      if (generation !== this.generation || this.activeGeneration !== generation || this.session !== session) return
      this.settleTerminal(generation)
    })
  }

  private settleTerminal(generation: number): void {
    if (generation !== this.generation || this.activeGeneration !== generation) return
    // An unavailable stream is terminal for acceleration, never for polling.
    this.input.onReady()
    this.input.coordinator.process({ type: 'resync' })
  }

  stop(): void {
    this.generation += 1
    this.activeGeneration = null
    this.scheduledGeneration = null
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
  const [readyWorkspaceId, setReadyWorkspaceId] = useState<string | null>(null)
  const liveInterestReady = readyWorkspaceId === workspaceId
  const lifecycle = useMemo(() => new DashboardLiveInterestLifecycle({
    coordinator,
    interest,
    workspaceId,
    onReady: () => setReadyWorkspaceId(workspaceId),
  }), [coordinator, interest, workspaceId])

  useEffect(() => coordinator.subscribe(), [coordinator])

  useEffect(() => {
    const onVisibilityChange = () => {
      const nextVisible = isDocumentVisible()
      setVisible(nextVisible)
      coordinator.setVisible(nextVisible)
      if (!nextVisible) {
        setReadyWorkspaceId(null)
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
