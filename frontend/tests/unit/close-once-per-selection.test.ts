import { describe, expect, it } from 'vitest'

import {
  admitClose,
  admitSelection,
  initialCloseOnceGuard,
  type CloseOnceGuard,
} from '@/lib/close-once-per-selection'

describe('close-once-per-selection', () => {
  it('closes once for a selection, then suppresses a second close for the same selection', () => {
    let guard: CloseOnceGuard = admitSelection(initialCloseOnceGuard, 'chat:A')

    const first = admitClose(guard)
    guard = first.guard
    expect(first.shouldClose).toBe(true)

    // A tail 404 racing an in-drawer delete's own close calls this again before either
    // state update has re-rendered the component with the cleared selection.
    const second = admitClose(guard)
    guard = second.guard
    expect(second.shouldClose).toBe(false)
  })

  it('does not un-suppress a pending close just because the selection cleared to null', () => {
    let guard: CloseOnceGuard = admitSelection(initialCloseOnceGuard, 'chat:A')
    const { guard: closedGuard } = admitClose(guard)
    guard = closedGuard

    // The component re-renders with the selection cleared (what the first close itself caused).
    guard = admitSelection(guard, null)

    const lateClose = admitClose(guard)
    expect(lateClose.shouldClose).toBe(false)
  })

  it('allows a fresh close after a different selection opens', () => {
    let guard: CloseOnceGuard = admitSelection(initialCloseOnceGuard, 'chat:A')
    guard = admitClose(guard).guard

    guard = admitSelection(guard, 'chat:B')

    expect(admitClose(guard).shouldClose).toBe(true)
  })

  it('allows a fresh close when the same id is reopened after being cleared', () => {
    let guard: CloseOnceGuard = admitSelection(initialCloseOnceGuard, 'chat:A')
    guard = admitClose(guard).guard

    guard = admitSelection(guard, null)
    guard = admitSelection(guard, 'chat:A')

    expect(admitClose(guard).shouldClose).toBe(true)
  })

  it('is a no-op to re-admit the same selection repeatedly before any close', () => {
    let guard: CloseOnceGuard = admitSelection(initialCloseOnceGuard, 'chat:A')
    guard = admitSelection(guard, 'chat:A')
    guard = admitSelection(guard, 'chat:A')

    expect(admitClose(guard).shouldClose).toBe(true)
  })
})
