/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBackgroundRefresh } from '@/hooks/use-background-refresh'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

vi.mock('@/lib/workspace-events-context', () => ({
  useWorkspaceEventsOptional: vi.fn(),
}))

const useWorkspaceEventsOptionalMock = vi.mocked(useWorkspaceEventsOptional)

let container: HTMLDivElement
let root: Root

const emitPush = () => {
  const invalidate = useWorkspaceEventsOptionalMock.mock.calls.at(-1)?.[1]
  if (!invalidate) {
    throw new Error('The hook never subscribed to the workspace push channel.')
  }
  act(() => invalidate())
}

const subscribedKinds = (): readonly string[] =>
  useWorkspaceEventsOptionalMock.mock.calls.at(-1)?.[0] ?? []

function Probe({
  onRefresh,
  intervalMs,
  suspended,
}: {
  onRefresh: () => void
  intervalMs?: number
  suspended?: boolean
}) {
  useBackgroundRefresh({
    changeKinds: ['quality.triage_changed'],
    onRefresh,
    intervalMs,
    suspended,
  })
  return null
}

const render = (props: { onRefresh: () => void; intervalMs?: number; suspended?: boolean }) => {
  act(() => {
    root.render(<Probe {...props} />)
  })
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.useFakeTimers()
  useWorkspaceEventsOptionalMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useBackgroundRefresh', () => {
  it('subscribes to the requested change kinds and refetches on a push', () => {
    const onRefresh = vi.fn()
    render({ onRefresh })

    expect(subscribedKinds()).toEqual(['quality.triage_changed'])
    expect(onRefresh).not.toHaveBeenCalled()

    emitPush()

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('holds a push while the operator is mid-action and replays it once', () => {
    const onRefresh = vi.fn()
    render({ onRefresh, suspended: true })

    emitPush()
    emitPush()
    expect(onRefresh).not.toHaveBeenCalled()

    render({ onRefresh, suspended: false })

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not refetch when nothing arrived while suspended', () => {
    const onRefresh = vi.fn()
    render({ onRefresh, suspended: true })
    render({ onRefresh, suspended: false })

    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('reconciles on the interval floor and stops on unmount', () => {
    const onRefresh = vi.fn()
    render({ onRefresh, intervalMs: 60_000 })

    act(() => {
      vi.advanceTimersByTime(59_999)
    })
    expect(onRefresh).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)

    act(() => root.render(null))
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the reconcile floor quiet while suspended', () => {
    const onRefresh = vi.fn()
    render({ onRefresh, intervalMs: 60_000, suspended: true })

    act(() => {
      vi.advanceTimersByTime(180_000)
    })
    expect(onRefresh).not.toHaveBeenCalled()

    render({ onRefresh, intervalMs: 60_000, suspended: false })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('always calls the latest onRefresh', () => {
    const first = vi.fn()
    const second = vi.fn()
    render({ onRefresh: first })
    render({ onRefresh: second })

    emitPush()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
