/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useHistoryListState } from '@/components/dashboard/history/use-chat-history-state'
import { chatApi } from '@/lib/api'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  chatApi: {
    listHistory: vi.fn(),
    listChatHistory: vi.fn(),
    listContactHistory: vi.fn(),
    listSearchHistory: vi.fn(),
  },
  documentsApi: {},
}))

vi.mock('@/lib/workspace-events-context', () => ({
  useWorkspaceEventsOptional: vi.fn(),
}))

const chatApiMock = vi.mocked(chatApi)
const useWorkspaceEventsOptionalMock = vi.mocked(useWorkspaceEventsOptional)
const router = { push: vi.fn(), replace: vi.fn() }

const routeState: DashboardRouteState = {
  section: 'activity',
  workspaceId: 'workspace-1',
  historyFilter: 'all',
  historyPage: 2,
}

let container: HTMLDivElement
let root: Root

function Probe() {
  useHistoryListState({ accountId: 'account-1', routeState })
  return null
}

const renderProbe = async () => {
  await act(async () => {
    root.render(<Probe />)
    await Promise.resolve()
  })
}

beforeAll(async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const { useRouter } = await import('next/navigation')
  vi.mocked(useRouter).mockReturnValue(router as never)
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  chatApiMock.listHistory.mockResolvedValue({ items: [], total: 100, hasMore: true } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useHistoryListState', () => {
  it('refetches the current history slice when a workspace hint arrives', async () => {
    await renderProbe()
    expect(chatApiMock.listHistory).toHaveBeenCalledWith({ limit: 50, offset: 50 })
    expect(useWorkspaceEventsOptionalMock).toHaveBeenLastCalledWith(
      [
        'conversation.created',
        'conversation.updated',
        'conversation.contact_delivery_changed',
        'search.created',
      ],
      expect.any(Function),
    )

    const onInvalidate = useWorkspaceEventsOptionalMock.mock.calls.at(-1)?.[1]
    const initialCallCount = chatApiMock.listHistory.mock.calls.length
    await act(async () => {
      onInvalidate?.()
      await Promise.resolve()
    })

    expect(chatApiMock.listHistory).toHaveBeenCalledTimes(initialCallCount + 1)
    expect(chatApiMock.listHistory).toHaveBeenLastCalledWith({ limit: 50, offset: 50 })
  })

  it('reconciles the mounted history slice every 60 seconds', async () => {
    await renderProbe()
    chatApiMock.listHistory.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(chatApiMock.listHistory).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(chatApiMock.listHistory).toHaveBeenCalledTimes(1)
  })
})
