// @vitest-environment jsdom

import { useQuery, type QueryFunctionContext } from '@tanstack/react-query'
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  useDashboardQueryInvalidation,
  useDashboardQueryPolicy,
} from '@/components/providers/dashboard-query-provider'
import { WorkspaceEventsProvider } from '@/components/providers/workspace-events-provider'
import type { WorkspaceEventsCallbacks, WorkspaceEventsClient } from '@/lib/workspace-events-client'

const createWorkspaceEventsClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-events-client', () => ({ createWorkspaceEventsClient }))

const WORKSPACE_A = 'workspace-a'
const WORKSPACE_B = 'workspace-b'
const DOCUMENTS_KEY = (workspaceId: string) => ['workspace', workspaceId, 'documents', 'list', null, 1, 25] as const

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakeConnection = { close: () => void | Promise<void>; done: Promise<void> }
type FakeClient = WorkspaceEventsClient & { callbacks?: WorkspaceEventsCallbacks; connection: FakeConnection }

const clients: FakeClient[] = []

const makeClient = (): FakeClient => {
  const connection: FakeConnection = { close: vi.fn(() => undefined), done: new Promise<void>(() => undefined) }
  const client: FakeClient = {
    connection,
    connect: vi.fn((callbacks: WorkspaceEventsCallbacks) => {
      client.callbacks = callbacks
      return connection
    }),
  }
  clients.push(client)
  return client
}

const flush = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

const render = async (element: React.ReactNode) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(element); await flush() })
  return root
}

function Probe({ workspaceId, onPolicy, queryFn }: {
  workspaceId: string
  onPolicy?: (enabled: boolean) => void
  queryFn: (context: QueryFunctionContext) => Promise<unknown>
}) {
  const policy = useDashboardQueryPolicy()
  const invalidate = useDashboardQueryInvalidation()
  useEffect(() => { onPolicy?.(policy.queriesEnabled) }, [onPolicy, policy.queriesEnabled])
  useQuery({
    queryKey: DOCUMENTS_KEY(workspaceId),
    queryFn,
    enabled: policy.queriesEnabled,
    refetchInterval: false,
  })
  // Keep the invalidation context exercised by the provider contract.
  void invalidate
  return null
}

afterEach(() => {
  createWorkspaceEventsClient.mockReset()
  clients.length = 0
  document.body.replaceChildren()
})

describe('workspace events provider', () => {
  it('does not construct a client or invoke fetch when realtime is disabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const queryFn = vi.fn(async () => 'poll')
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled={false}>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} />
      </WorkspaceEventsProvider>,
    )

    expect(createWorkspaceEventsClient).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queryFn).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    fetchMock.mockRestore()
  })

  it('uses the exact workspace, maps ready/invalidate/resync, and settles terminal as poll-only', async () => {
    const client = makeClient()
    createWorkspaceEventsClient.mockReturnValue(client)
    const queryFn = vi.fn(async () => 'fresh')
    const policies: boolean[] = []
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} onPolicy={(enabled) => policies.push(enabled)} />
      </WorkspaceEventsProvider>,
    )

    expect(createWorkspaceEventsClient).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_A }))
    expect(client.connect).toHaveBeenCalledOnce()
    expect(queryFn).not.toHaveBeenCalled()

    await act(async () => {
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledOnce()
    expect(policies.at(-1)).toBe(true)

    await act(async () => {
      client.callbacks?.onInvalidate?.({ protocolVersion: 1, type: 'invalidate', changeKinds: ['document.status_changed'] })
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)

    await act(async () => {
      client.callbacks?.onResync?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(3)

    // A terminal stream is still a successful poll-only outcome.
    const terminalClient = makeClient()
    createWorkspaceEventsClient.mockReturnValueOnce(terminalClient)
    await act(async () => {
      root.render(
        <WorkspaceEventsProvider workspaceId={WORKSPACE_B} realtimeEnabled>
          <Probe workspaceId={WORKSPACE_B} queryFn={async () => 'terminal-poll'} onPolicy={(enabled) => policies.push(enabled)} />
        </WorkspaceEventsProvider>,
      )
      await flush()
    })
    await act(async () => {
      terminalClient.callbacks?.onTerminal?.({ status: 403 })
      await flush()
    })
    expect(policies.at(-1)).toBe(true)
    await act(async () => root.unmount())
  })

  it('re-establishes subscribe-before-enable when cached poll-only state becomes realtime-enabled', async () => {
    const queryFn = vi.fn(async () => 'fresh')
    const policies: boolean[] = []
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled={false}>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} onPolicy={(enabled) => policies.push(enabled)} />
      </WorkspaceEventsProvider>,
    )
    expect(queryFn).toHaveBeenCalledOnce()
    expect(policies.at(-1)).toBe(true)

    const client = makeClient()
    createWorkspaceEventsClient.mockReturnValueOnce(client)
    await act(async () => {
      root.render(
        <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
          <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} onPolicy={(enabled) => policies.push(enabled)} />
        </WorkspaceEventsProvider>,
      )
      await flush()
    })
    expect(client.connect).toHaveBeenCalledOnce()
    expect(policies.at(-1)).toBe(false)
    expect(queryFn).toHaveBeenCalledOnce()

    await act(async () => {
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(policies.at(-1)).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })

  it('releases the initial query gate on retry without closing the reconnecting client', async () => {
    const client = makeClient()
    createWorkspaceEventsClient.mockReturnValue(client)
    const queryFn = vi.fn(async () => 'polling-during-retry')
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} />
      </WorkspaceEventsProvider>,
    )

    expect(queryFn).not.toHaveBeenCalled()
    await act(async () => {
      client.callbacks?.onRetrying({ reason: 'network', delayMs: 1_000 })
      await flush()
    })

    expect(queryFn).toHaveBeenCalledOnce()
    expect(client.connection.close).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(client.connection.close).toHaveBeenCalledOnce()
  })

  it('reconciles active queries when a retrying stream becomes ready', async () => {
    const client = makeClient()
    createWorkspaceEventsClient.mockReturnValue(client)
    const queryFn = vi.fn(async () => 'reconciled-after-gap')
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} />
      </WorkspaceEventsProvider>,
    )

    await act(async () => {
      client.callbacks?.onRetrying({ reason: 'network', delayMs: 1_000 })
      await flush()
    })
    expect(queryFn).toHaveBeenCalledOnce()

    await act(async () => {
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(client.connection.close).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('reconciles again after a second retry and ready generation', async () => {
    const client = makeClient()
    createWorkspaceEventsClient.mockReturnValue(client)
    const queryFn = vi.fn(async () => 'reconciled-each-generation')
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} />
      </WorkspaceEventsProvider>,
    )

    await act(async () => {
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledOnce()

    await act(async () => {
      client.callbacks?.onRetrying({ reason: 'eof', delayMs: 1_000 })
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)

    await act(async () => {
      client.callbacks?.onRetrying({ reason: 'network', delayMs: 2_000 })
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(3)
    await act(async () => root.unmount())
  })

  it('reconciles terminal after ready once and remains poll-only', async () => {
    const client = makeClient()
    createWorkspaceEventsClient.mockReturnValue(client)
    const queryFn = vi.fn(async () => 'terminal-poll')
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
        <Probe workspaceId={WORKSPACE_A} queryFn={queryFn} />
      </WorkspaceEventsProvider>,
    )

    await act(async () => {
      client.callbacks?.onReady?.()
      await flush()
    })
    expect(queryFn).toHaveBeenCalledOnce()

    await act(async () => {
      client.callbacks?.onRetrying({ reason: 'eof', delayMs: 1_000 })
      client.callbacks?.onTerminal?.({ status: 403 })
      client.callbacks?.onTerminal?.({ status: 403 })
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)

    await act(async () => {
      client.callbacks?.onReady?.()
      client.callbacks?.onInvalidate?.({ protocolVersion: 1, type: 'invalidate', changeKinds: ['document.status_changed'] })
      await flush()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(client.connection.close).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    expect(client.connection.close).toHaveBeenCalledOnce()
  })

  it('closes once on disable or workspace switch and ignores stale callbacks', async () => {
    const first = makeClient()
    const second = makeClient()
    createWorkspaceEventsClient.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const firstQuery = vi.fn(async () => 'first')
    const secondQuery = vi.fn(async () => 'second')
    const root = await render(
      <WorkspaceEventsProvider workspaceId={WORKSPACE_A} realtimeEnabled>
        <Probe workspaceId={WORKSPACE_A} queryFn={firstQuery} />
      </WorkspaceEventsProvider>,
    )
    const staleCallbacks = first.callbacks
    await act(async () => {
      root.render(
        <WorkspaceEventsProvider workspaceId={WORKSPACE_B} realtimeEnabled>
          <Probe workspaceId={WORKSPACE_B} queryFn={secondQuery} />
        </WorkspaceEventsProvider>,
      )
      await flush()
    })
    expect(first.connection.close).toHaveBeenCalledOnce()
    expect(createWorkspaceEventsClient).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_B }))

    await act(async () => {
      staleCallbacks?.onReady?.()
      staleCallbacks?.onInvalidate?.({ protocolVersion: 1, type: 'invalidate', changeKinds: ['document.status_changed'] })
      await flush()
    })
    expect(firstQuery).not.toHaveBeenCalled()

    await act(async () => {
      root.render(
        <WorkspaceEventsProvider workspaceId={WORKSPACE_B} realtimeEnabled={false}>
          <Probe workspaceId={WORKSPACE_B} queryFn={secondQuery} />
        </WorkspaceEventsProvider>,
      )
      await flush()
      root.unmount()
    })
    expect(second.connection.close).toHaveBeenCalledOnce()
  })
})
