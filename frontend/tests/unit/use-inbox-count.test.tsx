/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInboxCount } from '@/hooks/use-inbox-count'
import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

vi.mock('@/lib/api', () => ({
  chatApi: { listChatHistory: vi.fn() },
}))

vi.mock('@/lib/api-hitl', () => ({
  hitlApi: { listPendingDecisions: vi.fn() },
}))

vi.mock('@/lib/workspace-events-context', () => ({
  useWorkspaceEventsOptional: vi.fn(),
}))

const chatApiMock = vi.mocked(chatApi)
const hitlApiMock = vi.mocked(hitlApi)
const useWorkspaceEventsOptionalMock = vi.mocked(useWorkspaceEventsOptional)

let container: HTMLDivElement
let root: Root
const observed = { current: 0 }

function Probe() {
  const count = useInboxCount({ intervalMs: 30_000 })
  useEffect(() => {
    observed.current = count
  }, [count])
  return null
}

function DefaultCadenceProbe() {
  useInboxCount()
  return null
}

const renderProbe = async () => {
  await act(async () => {
    root.render(<Probe />)
    await Promise.resolve()
  })
}

const renderDefaultCadenceProbe = async () => {
  await act(async () => {
    root.render(<DefaultCadenceProbe />)
    await Promise.resolve()
  })
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  observed.current = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('useInboxCount', () => {
  it('adds pending approvals and human-owned conversation totals', async () => {
    hitlApiMock.listPendingDecisions.mockResolvedValue({ decisions: [{ handle: 'approval-1' }, { handle: 'approval-2' }] } as never)
    chatApiMock.listChatHistory.mockResolvedValue({ total: 3 } as never)

    await renderProbe()

    expect(observed.current).toBe(5)
    expect(chatApiMock.listChatHistory).toHaveBeenCalledWith({ limit: 1, ownership: 'human_owned' })
  })

  it('preserves the prior value for a source that fails without freezing the other source', async () => {
    hitlApiMock.listPendingDecisions
      .mockResolvedValueOnce({ decisions: [{ handle: 'approval-1' }] } as never)
      .mockRejectedValueOnce(new Error('approvals unavailable'))
    chatApiMock.listChatHistory
      .mockResolvedValueOnce({ total: 2 } as never)
      .mockResolvedValueOnce({ total: 4 } as never)

    await renderProbe()
    expect(observed.current).toBe(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(observed.current).toBe(5)
  })

  it('refreshes the badge when a matching workspace hint arrives', async () => {
    hitlApiMock.listPendingDecisions
      .mockResolvedValueOnce({ decisions: [] } as never)
      .mockResolvedValueOnce({ decisions: [{ handle: 'approval-1' }] } as never)
    chatApiMock.listChatHistory
      .mockResolvedValueOnce({ total: 0 } as never)
      .mockResolvedValueOnce({ total: 2 } as never)

    await renderProbe()
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(useWorkspaceEventsOptionalMock).toHaveBeenLastCalledWith(
      [
        'hitl.decision_created',
        'hitl.decision_resolved',
        'conversation.ownership_changed',
      ],
      expect.any(Function),
    )

    const onInvalidate = useWorkspaceEventsOptionalMock.mock.calls.at(-1)?.[1]
    await act(async () => {
      onInvalidate?.()
      await Promise.resolve()
    })

    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(2)
    expect(observed.current).toBe(3)
  })

  it('retains a 60 second reconcile floor by default', async () => {
    hitlApiMock.listPendingDecisions.mockResolvedValue({ decisions: [] } as never)
    chatApiMock.listChatHistory.mockResolvedValue({ total: 0 } as never)

    await renderDefaultCadenceProbe()
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(2)
  })
})
