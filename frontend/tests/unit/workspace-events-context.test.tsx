/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { streamWorkspaceEvents, type WorkspaceEventsHandlers } from '@/lib/api-events'
import {
  WorkspaceEventsProvider,
  useWorkspaceEvents,
  useWorkspaceEventsOptional,
} from '@/lib/workspace-events-context'
import { useWorkspace } from '@/lib/workspace-context'

vi.mock('@/lib/api-events', () => ({
  streamWorkspaceEvents: vi.fn(),
}))

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: vi.fn(),
}))

const streamWorkspaceEventsMock = vi.mocked(streamWorkspaceEvents)
const useWorkspaceMock = vi.mocked(useWorkspace)

let container: HTMLDivElement
let root: Root
let connections: Array<{ handlers: WorkspaceEventsHandlers; signal: AbortSignal }>

function Probe({ changeKinds, onInvalidate }: { changeKinds: string[]; onInvalidate: () => void }) {
  useWorkspaceEvents(changeKinds, onInvalidate)
  return null
}

function OptionalProbe({ onInvalidate }: { onInvalidate: () => void }) {
  useWorkspaceEventsOptional(['document.status_changed'], onInvalidate)
  return null
}

const event = (changeKind: string, version = 1) => ({
  resourceType: 'document',
  resourceId: 'document-1',
  workspaceId: 'workspace-1',
  changeKind,
  version,
})

const renderProbe = async (changeKinds: string[], onInvalidate: () => void) => {
  await act(async () => {
    root.render(
      <WorkspaceEventsProvider>
        <Probe changeKinds={changeKinds} onInvalidate={onInvalidate} />
      </WorkspaceEventsProvider>,
    )
    await Promise.resolve()
  })
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  connections = []
  useWorkspaceMock.mockReturnValue({ activeWorkspaceId: 'workspace-1' } as never)
  streamWorkspaceEventsMock.mockImplementation((handlers, signal) => {
    connections.push({ handlers, signal })
    return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('WorkspaceEventsProvider', () => {
  it('allows optional subscribers outside the dashboard provider', () => {
    const onInvalidate = vi.fn()

    expect(() => {
      act(() => {
        root.render(<OptionalProbe onInvalidate={onInvalidate} />)
      })
    }).not.toThrow()
    expect(streamWorkspaceEventsMock).not.toHaveBeenCalled()
  })

  it('dispatches only matching change kinds', async () => {
    const onInvalidate = vi.fn()
    await renderProbe(['document.status_changed'], onInvalidate)

    act(() => connections[0].handlers.onPush(event('crawl.progress')))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(onInvalidate).not.toHaveBeenCalled()

    act(() => connections[0].handlers.onPush(event('document.status_changed')))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(onInvalidate).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst into one trailing refetch', async () => {
    const onInvalidate = vi.fn()
    await renderProbe(['document.status_changed'], onInvalidate)

    act(() => {
      connections[0].handlers.onPush(event('document.status_changed', 1))
      connections[0].handlers.onPush(event('document.status_changed', 2))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(onInvalidate).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(onInvalidate).toHaveBeenCalledTimes(1)
  })

  it('refetches all subscriptions when the channel opens or reconnects', async () => {
    const onInvalidate = vi.fn()
    await renderProbe(['document.status_changed'], onInvalidate)

    act(() => connections[0].handlers.onReady())
    expect(onInvalidate).toHaveBeenCalledTimes(1)

    act(() => connections[0].handlers.onReady())
    expect(onInvalidate).toHaveBeenCalledTimes(2)
  })

  it('reopens the channel when the active workspace changes', async () => {
    const onInvalidate = vi.fn()
    await renderProbe(['document.status_changed'], onInvalidate)
    expect(connections).toHaveLength(1)
    expect(connections[0].signal.aborted).toBe(false)

    useWorkspaceMock.mockReturnValue({ activeWorkspaceId: 'workspace-2' } as never)
    await renderProbe(['document.status_changed'], onInvalidate)

    expect(connections).toHaveLength(2)
    expect(connections[0].signal.aborted).toBe(true)
    act(() => connections[1].handlers.onReady())
    expect(onInvalidate).toHaveBeenCalledTimes(1)
  })
})
