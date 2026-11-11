/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBulkDismiss, type BulkDismissController } from '@/components/dashboard/inbox/use-bulk-dismiss'
import { qualityApi, type QualityTriageRecord } from '@/lib/api-quality'
import type { InboxItem } from '@/lib/needs-attention'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const feedbackItem = (id: string): InboxItem => ({
  key: `feedback:${id}`,
  conversationId: `conversation-${id}`,
  type: 'negative_feedback',
  severity: 'feedback',
  title: `Feedback ${id}`,
  detail: 'Sola',
  timestamp: '2026-06-19T10:00:00.000Z',
  assistantMessageId: id,
  triageState: 'open',
  triage: { state: 'open', version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null },
})

const dismissed = (): QualityTriageRecord => ({
  state: 'dismissed',
  version: 1,
  resolution: null,
  legacyReason: null,
  closedAt: null,
  updatedAt: null,
})

interface HarnessProps {
  workspaceId: string
  items: InboxItem[]
}

function renderBulkDismiss(initial: HarnessProps) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let controller: BulkDismissController | null = null
  const onResult = vi.fn()
  const onAnnounce = vi.fn()

  function Harness({ workspaceId, items }: HarnessProps) {
    controller = useBulkDismiss({ workspaceId, items, onResult, onAnnounce })
    return null
  }

  const render = (next: HarnessProps) => {
    act(() => root.render(<Harness {...next} />))
  }
  render(initial)

  return {
    bulk: (): BulkDismissController => {
      if (!controller) throw new Error('not rendered')
      return controller
    },
    render,
    onResult,
    onAnnounce,
    unmount: () => act(() => root.unmount()),
  }
}

describe('useBulkDismiss', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('drops a selected row once it is no longer visible, so it is not ticked when it returns', () => {
    const [a, b] = [feedbackItem('a'), feedbackItem('b')]
    const view = renderBulkDismiss({ workspaceId: 'workspace-1', items: [a, b] })

    act(() => view.bulk().toggle(a))
    act(() => view.bulk().toggle(b))
    expect(view.bulk().selectedCount).toBe(2)

    // A filter hides `a`.
    view.render({ workspaceId: 'workspace-1', items: [b] })
    expect(view.bulk().selectedCount).toBe(1)

    // Clearing the filter shows it again, unticked.
    view.render({ workspaceId: 'workspace-1', items: [a, b] })
    expect(view.bulk().isSelected(a)).toBe(false)
    expect(view.bulk().isSelected(b)).toBe(true)
    expect(view.bulk().selectedCount).toBe(1)
    view.unmount()
  })

  it('keeps the selection when the same rows are read again', () => {
    const a = feedbackItem('a')
    const view = renderBulkDismiss({ workspaceId: 'workspace-1', items: [a] })

    act(() => view.bulk().toggle(a))
    view.render({ workspaceId: 'workspace-1', items: [{ ...a }] })

    expect(view.bulk().selectedCount).toBe(1)
    view.unmount()
  })

  it('sends no queued dismissal to another workspace after the workspace changes', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map(feedbackItem)
    const releases: Array<() => void> = []
    const setTriageState = vi.spyOn(qualityApi, 'setTriageState').mockImplementation(
      () => new Promise<QualityTriageRecord>((resolve) => { releases.push(() => resolve(dismissed())) }),
    )
    const view = renderBulkDismiss({ workspaceId: 'workspace-1', items })

    act(() => view.bulk().selectAll())
    let run: Promise<void> = Promise.resolve()
    act(() => { run = view.bulk().dismiss(null) })
    // Four are sent; two wait their turn.
    expect(setTriageState).toHaveBeenCalledTimes(4)

    view.render({ workspaceId: 'workspace-2', items: [] })
    releases.forEach((release) => release())
    await act(async () => { await run })

    expect(setTriageState).toHaveBeenCalledTimes(4)
    expect(view.onResult).not.toHaveBeenCalled()
    expect(view.onAnnounce).not.toHaveBeenCalled()
    view.unmount()
  })

  it('sends no queued dismissal once the view is gone', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map(feedbackItem)
    const releases: Array<() => void> = []
    const setTriageState = vi.spyOn(qualityApi, 'setTriageState').mockImplementation(
      () => new Promise<QualityTriageRecord>((resolve) => { releases.push(() => resolve(dismissed())) }),
    )
    const view = renderBulkDismiss({ workspaceId: 'workspace-1', items })

    act(() => view.bulk().selectAll())
    let run: Promise<void> = Promise.resolve()
    act(() => { run = view.bulk().dismiss(null) })
    view.unmount()
    releases.forEach((release) => release())
    await act(async () => { await run })

    expect(setTriageState).toHaveBeenCalledTimes(4)
  })
})
