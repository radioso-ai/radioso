// @vitest-environment jsdom

import { QueryClient, QueryObserver, type QueryFunctionContext, useQuery, useQueryClient } from '@tanstack/react-query'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createDashboardQueryClient,
  dashboardQueryIntervalMs,
  dashboardQueryJitterMs,
  DashboardLiveInterestLifecycle,
  DashboardQueryProvider,
  isDashboardQueryRetryable,
  useDashboardQueryPolicy,
  type DashboardLiveInterest,
} from '@/components/providers/dashboard-query-provider'
import { DashboardQueryInvalidationCoordinator } from '@/lib/dashboard-query-invalidation'

const workspaceId = 'workspace-a'
const key = ['workspace', workspaceId, 'documents', 'list', null, 1, 25]

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  document.body.replaceChildren()
})

function Probe({ onPolicy, queryFn, activeMs, workspaceId: probeWorkspaceId = workspaceId }: {
  activeMs?: number
  onPolicy: (value: ReturnType<typeof useDashboardQueryPolicy>, client: QueryClient) => void
  queryFn?: (context: QueryFunctionContext) => Promise<unknown>
  workspaceId?: string
}) {
  const policy = useDashboardQueryPolicy()
  const client = useQueryClient()
  const queryKey = ['workspace', probeWorkspaceId, 'documents', 'list', null, 1, 25]
  useQuery({
    queryKey,
    queryFn: queryFn ?? (() => Promise.resolve('ok')),
    enabled: policy.queriesEnabled,
    refetchInterval: policy.intervalFor(queryKey, activeMs),
  })
  onPolicy(policy, client)
  return null
}

const renderProvider = async (element: React.ReactNode) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  return { root, container }
}

describe('dashboard query provider policy', () => {
  it('derives deterministic visible-query jitter and chooses active cadence without weakening its ceiling', () => {
    expect(dashboardQueryJitterMs(key)).toBe(dashboardQueryJitterMs(key))
    expect(dashboardQueryJitterMs(key)).toBeGreaterThanOrEqual(45_000)
    expect(dashboardQueryJitterMs(key)).toBeLessThanOrEqual(60_000)
    expect(dashboardQueryIntervalMs(key)).toBe(dashboardQueryJitterMs(key))
    expect(dashboardQueryIntervalMs(key, 2_000)).toBe(2_000)
    expect(dashboardQueryIntervalMs(key, 5_000)).toBe(5_000)
    expect(dashboardQueryIntervalMs(key, 90_000)).toBe(dashboardQueryJitterMs(key))
  })

  it('installs the jitter default on real observers while active cadence overrides it', () => {
    const client = createDashboardQueryClient()
    const observer = new QueryObserver(client, { queryKey: key, queryFn: () => Promise.resolve('ok') })
    const defaults = client.defaultQueryOptions(observer.options)
    expect(defaults.refetchInterval).toBeTypeOf('function')
    const refetchInterval = defaults.refetchInterval
    if (typeof refetchInterval !== 'function') throw new Error('Expected dashboard refetch interval function.')
    expect(refetchInterval(observer.getCurrentQuery())).toBe(dashboardQueryJitterMs(key))
    expect(dashboardQueryIntervalMs(key, 2_000)).toBe(2_000)
    expect(dashboardQueryIntervalMs(key, 5_000)).toBe(5_000)
  })

  it('honors 2s and 5s active polling under fake timers without depending on stream state', async () => {
    vi.useFakeTimers()
    for (const activeMs of [2_000, 5_000]) {
      const client = createDashboardQueryClient()
      const queryFn = vi.fn(() => Promise.resolve(activeMs))
      const observer = new QueryObserver(client, {
        queryKey: [...key, activeMs],
        queryFn,
        refetchInterval: dashboardQueryIntervalMs([...key, activeMs], activeMs),
      })
      const unobserve = observer.subscribe(() => undefined)
      await observer.refetch()
      await vi.advanceTimersByTimeAsync(activeMs - 1)
      expect(queryFn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(queryFn).toHaveBeenCalledTimes(2)
      unobserve()
    }
  })

  it('uses the deterministic jitter as the real observer default poll floor', async () => {
    vi.useFakeTimers()
    const client = createDashboardQueryClient()
    const queryFn = vi.fn(() => Promise.resolve('default'))
    const observer = new QueryObserver(client, { queryKey: key, queryFn })
    const unobserve = observer.subscribe(() => undefined)
    await observer.refetch()
    const interval = dashboardQueryJitterMs(key)
    await vi.advanceTimersByTimeAsync(interval - 1)
    expect(queryFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(queryFn).toHaveBeenCalledTimes(2)
    unobserve()
  })

  it('excludes structural aborts and auth errors while bounding ordinary retries', () => {
    const client = createDashboardQueryClient()
    const retry = client.defaultQueryOptions({ queryKey: key }).retry
    expect(isDashboardQueryRetryable({ name: 'AbortError' })).toBe(false)
    expect(isDashboardQueryRetryable({ status: 401 })).toBe(false)
    expect(isDashboardQueryRetryable({ status: 403 })).toBe(false)
    expect(isDashboardQueryRetryable(new Error('network'))).toBe(true)
    expect(typeof retry === 'function' && retry(0, new Error('network'))).toBe(true)
    expect(typeof retry === 'function' && retry(2, new Error('network'))).toBe(false)
  })

  it('opens one session before enabling and terminal outcomes retain polling', async () => {
    const outcome = deferred<'terminal'>()
    const session = { outcome: outcome.promise, close: vi.fn() }
    const interest = {
      open: vi.fn((input: Parameters<DashboardLiveInterest['open']>[0]) => {
        void input
        return session
      }),
    }
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: new QueryClient(), workspaceId })
    const onReady = vi.fn()
    const lifecycle = new DashboardLiveInterestLifecycle({ coordinator, interest, onReady, workspaceId })

    lifecycle.start()
    lifecycle.start()
    await flush()
    expect(interest.open).toHaveBeenCalledOnce()
    expect(onReady).not.toHaveBeenCalled()
    outcome.resolve('terminal')
    await flush()
    expect(onReady).toHaveBeenCalledOnce()
    lifecycle.stop()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('fences old sessions and absorbs close rejection without touching a new session', async () => {
    const firstOutcome = deferred<'ready'>()
    const secondOutcome = deferred<'ready'>()
    const first = { outcome: firstOutcome.promise, close: vi.fn(() => Promise.reject(new Error('closed'))) }
    const second = { outcome: secondOutcome.promise, close: vi.fn() }
    const interest = { open: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) }
    const onReady = vi.fn()
    const coordinator = new DashboardQueryInvalidationCoordinator({ queryClient: new QueryClient(), workspaceId })
    const lifecycle = new DashboardLiveInterestLifecycle({ coordinator, interest, onReady, workspaceId })

    lifecycle.start()
    await flush()
    lifecycle.stop()
    lifecycle.start()
    await flush()
    firstOutcome.resolve('ready')
    secondOutcome.resolve('ready')
    await flush()
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('renders in StrictMode without duplicate no-interest readiness and keeps the hidden initial query disabled', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const queryFn = vi.fn(() => Promise.resolve('ok'))
    const policies: ReturnType<typeof useDashboardQueryPolicy>[] = []
    const { root } = await renderProvider(
      <StrictMode>
        <DashboardQueryProvider workspaceId={workspaceId}>
          <Probe queryFn={queryFn} onPolicy={(policy) => policies.push(policy)} />
        </DashboardQueryProvider>
      </StrictMode>,
    )
    await flush()
    expect(queryFn).not.toHaveBeenCalled()
    expect(policies.at(-1)?.queriesEnabled).toBe(false)
    await act(async () => { root.unmount() })
  })

  it('renders visible no-interest StrictMode with one readiness path and one active visibility reaction', async () => {
    const queryFn = vi.fn(() => Promise.resolve('ok'))
    const policies: ReturnType<typeof useDashboardQueryPolicy>[] = []
    const { root } = await renderProvider(
      <StrictMode>
        <DashboardQueryProvider workspaceId={workspaceId}>
          <Probe queryFn={queryFn} onPolicy={(policy) => policies.push(policy)} />
        </DashboardQueryProvider>
      </StrictMode>,
    )
    await act(async () => { await flush() })
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(policies.at(-1)?.queriesEnabled).toBe(true)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(policies.at(-1)?.queriesEnabled).toBe(false)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
    })
    expect(policies.at(-1)?.queriesEnabled).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
  })

  it('keeps the StrictMode coordinator active after ready and refetches from a live invalidation', async () => {
    const outcome = deferred<'ready'>()
    const session = { outcome: outcome.promise, close: vi.fn() }
    const interest = {
      open: vi.fn((input: Parameters<DashboardLiveInterest['open']>[0]) => {
        void input
        return session
      }),
    }
    const queryFn = vi.fn(() => Promise.resolve('ok'))
    const { root } = await renderProvider(
      <StrictMode>
        <DashboardQueryProvider workspaceId={workspaceId} interest={interest}>
          <Probe queryFn={queryFn} onPolicy={() => undefined} />
        </DashboardQueryProvider>
      </StrictMode>,
    )
    await act(async () => { await flush() })
    await act(async () => {
      outcome.resolve('ready')
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(1)
    const onInvalidation = interest.open.mock.calls[0]?.[0]?.onInvalidation
    if (!onInvalidation) throw new Error('Expected live invalidation callback.')
    await act(async () => {
      onInvalidation({ type: 'invalidate', kinds: ['document.status_changed'] })
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
  })

  it('aborts a visible pending query on hide and waits for the next terminal interest outcome before refetching', async () => {
    const firstOutcome = deferred<'ready'>()
    const secondOutcome = deferred<'terminal'>()
    const first = { outcome: firstOutcome.promise, close: vi.fn() }
    const second = { outcome: secondOutcome.promise, close: vi.fn() }
    const interest = { open: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) }
    const abort = vi.fn()
    let calls = 0
    const queryFn = vi.fn((context: QueryFunctionContext) => {
      calls += 1
      if (calls > 1) return Promise.resolve('visible-again')
      return new Promise<never>((_, reject) => {
        context.signal.addEventListener('abort', () => {
          abort()
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
        }, { once: true })
      })
    })
    const policies: ReturnType<typeof useDashboardQueryPolicy>[] = []
    const { root } = await renderProvider(
      <DashboardQueryProvider workspaceId={workspaceId} interest={interest}>
        <Probe queryFn={queryFn} onPolicy={(policy) => policies.push(policy)} />
      </DashboardQueryProvider>,
    )
    await act(async () => { await flush() })
    await act(async () => {
      firstOutcome.resolve('ready')
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(abort).toHaveBeenCalledOnce()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(policies.at(-1)?.queriesEnabled).toBe(false)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
    })
    expect(interest.open).toHaveBeenCalledTimes(2)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(policies.at(-1)?.queriesEnabled).toBe(false)

    await act(async () => {
      secondOutcome.resolve('terminal')
      await flush()
    })
    expect(policies.at(-1)?.queriesEnabled).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
  })

  it('subscribes before enabling, retains terminal polling, and closes only the old workspace session', async () => {
    const firstOutcome = deferred<'terminal'>()
    const secondOutcome = deferred<'ready'>()
    const first = { outcome: firstOutcome.promise, close: vi.fn() }
    const second = { outcome: secondOutcome.promise, close: vi.fn() }
    const interest = { open: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) }
    const firstRequest = deferred<unknown>()
    const firstAbort = vi.fn()
    const queryFn = vi.fn((context: QueryFunctionContext) => {
      if (context.queryKey[1] === 'workspace-a') {
        context.signal.addEventListener('abort', firstAbort, { once: true })
        return firstRequest.promise
      }
      return Promise.resolve('workspace-b')
    })
    const policies: Array<ReturnType<typeof useDashboardQueryPolicy>> = []
    const clients = new Map<string, QueryClient>()
    const { root } = await renderProvider(
      <StrictMode>
        <DashboardQueryProvider workspaceId="workspace-a" interest={interest}>
          <Probe
            queryFn={queryFn}
            onPolicy={(policy, client) => {
              policies.push(policy)
              clients.set('workspace-a', client)
            }}
          />
        </DashboardQueryProvider>
      </StrictMode>,
    )
    await act(async () => { await flush() })
    expect(interest.open).toHaveBeenCalledOnce()
    expect(queryFn).not.toHaveBeenCalled()
    expect(policies.at(-1)?.queriesEnabled).toBe(false)

    await act(async () => {
      firstOutcome.resolve('terminal')
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(policies.at(-1)?.queriesEnabled).toBe(true)

    await act(async () => {
      root.render(
        <StrictMode>
          <DashboardQueryProvider workspaceId="workspace-b" interest={interest}>
            <Probe
              workspaceId="workspace-b"
              queryFn={queryFn}
              onPolicy={(policy, client) => {
                policies.push(policy)
                clients.set('workspace-b', client)
              }}
            />
          </DashboardQueryProvider>
        </StrictMode>,
      )
      await flush()
    })
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(interest.open).toHaveBeenCalledTimes(2)
    expect(firstAbort).toHaveBeenCalledOnce()
    expect(clients.get('workspace-b')).not.toBe(clients.get('workspace-a'))
    expect(clients.get('workspace-b')?.getQueryData(key)).toBeUndefined()
    expect(queryFn).toHaveBeenCalledTimes(1)

    await act(async () => {
      secondOutcome.resolve('ready')
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
    expect(second.close).toHaveBeenCalledOnce()
  })
})
