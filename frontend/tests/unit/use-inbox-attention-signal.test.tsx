/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  didInboxOpenCountIncrease,
  formatInboxTabTitle,
  useInboxAttentionSignal,
} from '@/hooks/use-inbox-attention-signal'

const { playInboxChimeMock } = vi.hoisted(() => ({ playInboxChimeMock: vi.fn() }))

vi.mock('@/lib/inbox-chime', () => ({
  playInboxChime: playInboxChimeMock,
}))

describe('formatInboxTabTitle', () => {
  it('leaves the base title alone at zero open items', () => {
    expect(formatInboxTabTitle('Inbox - Radioso', 0)).toBe('Inbox - Radioso')
  })

  it('prefixes the count when items are open', () => {
    expect(formatInboxTabTitle('Inbox - Radioso', 3)).toBe('(3) Inbox - Radioso')
  })
})

describe('didInboxOpenCountIncrease', () => {
  it('is false with no known previous count', () => {
    expect(didInboxOpenCountIncrease(null, 5)).toBe(false)
  })

  it('is true when the count grew', () => {
    expect(didInboxOpenCountIncrease(2, 3)).toBe(true)
  })

  it('is false when the count held steady or dropped', () => {
    expect(didInboxOpenCountIncrease(3, 3)).toBe(false)
    expect(didInboxOpenCountIncrease(3, 1)).toBe(false)
  })
})

function renderAttentionSignal(initialOpenCount: number, initialCriticalOpenCount: number) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  function Harness({ openCount, criticalOpenCount }: { openCount: number; criticalOpenCount: number }) {
    useInboxAttentionSignal(openCount, criticalOpenCount)
    return null
  }

  act(() => {
    root.render(<Harness openCount={initialOpenCount} criticalOpenCount={initialCriticalOpenCount} />)
  })

  return {
    setCounts(openCount: number, criticalOpenCount: number) {
      act(() => {
        root.render(<Harness openCount={openCount} criticalOpenCount={criticalOpenCount} />)
      })
    },
    cleanup() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('useInboxAttentionSignal', () => {
  const originalTitle = document.title

  afterEach(() => {
    document.title = originalTitle
    playInboxChimeMock.mockClear()
  })

  it('prefixes the tab title with the total open count and restores it at zero', () => {
    document.title = 'Inbox - Radioso'
    const harness = renderAttentionSignal(2, 1)

    expect(document.title).toBe('(2) Inbox - Radioso')

    harness.setCounts(0, 0)
    expect(document.title).toBe('Inbox - Radioso')

    harness.cleanup()
  })

  it('restores the original title on unmount', () => {
    document.title = 'Inbox - Radioso'
    const harness = renderAttentionSignal(4, 2)

    expect(document.title).toBe('(4) Inbox - Radioso')

    harness.cleanup()
    expect(document.title).toBe('Inbox - Radioso')
  })

  it('does not chime on the initial render, even with critical items already open', () => {
    document.title = 'Inbox - Radioso'
    const harness = renderAttentionSignal(3, 3)

    expect(playInboxChimeMock).not.toHaveBeenCalled()

    harness.cleanup()
  })

  it('chimes when the critical open count increases', () => {
    document.title = 'Inbox - Radioso'
    const harness = renderAttentionSignal(1, 1)

    harness.setCounts(2, 2)
    expect(playInboxChimeMock).toHaveBeenCalledTimes(1)

    harness.cleanup()
  })

  it('does not chime when the critical open count decreases or holds steady', () => {
    document.title = 'Inbox - Radioso'
    const harness = renderAttentionSignal(3, 3)

    harness.setCounts(3, 3)
    harness.setCounts(1, 1)
    expect(playInboxChimeMock).not.toHaveBeenCalled()

    harness.cleanup()
  })

  it('moves the title but stays quiet when only feedback (non-critical) items arrive', () => {
    document.title = 'Inbox - Radioso'
    const harness = renderAttentionSignal(2, 1)

    // Total open count grows (a feedback item arrived) but the critical
    // subset (handoffs + approvals) is unchanged - title updates, no chime.
    harness.setCounts(3, 1)
    expect(document.title).toBe('(3) Inbox - Radioso')
    expect(playInboxChimeMock).not.toHaveBeenCalled()

    harness.cleanup()
  })

  it('chimes on a critical arrival even when the total open count happens to hold steady', () => {
    document.title = 'Inbox - Radioso'
    // Contrived but exercises the independence of the two counts: a handoff
    // arrives while a feedback item simultaneously closes, so the total is flat.
    const harness = renderAttentionSignal(3, 1)

    harness.setCounts(3, 2)
    expect(document.title).toBe('(3) Inbox - Radioso')
    expect(playInboxChimeMock).toHaveBeenCalledTimes(1)

    harness.cleanup()
  })
})
