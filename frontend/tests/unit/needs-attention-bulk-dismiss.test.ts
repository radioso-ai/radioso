import { describe, expect, it } from 'vitest'

import type { QualityTriageRecord } from '@/lib/api-quality'
import type { InboxItem } from '@/lib/needs-attention'
import {
  bulkDismissableItems,
  bulkDismissRowMessage,
  runBulkDismiss,
  summarizeBulkDismiss,
  type BulkDismissRowResult,
} from '@/lib/needs-attention-bulk-dismiss'

const triage = (overrides: Partial<QualityTriageRecord> = {}): QualityTriageRecord => ({
  state: 'open',
  version: 0,
  resolution: null,
  legacyReason: null,
  closedAt: null,
  updatedAt: null,
  ...overrides,
})

const feedbackItem = (id: string, overrides: Partial<InboxItem> = {}): InboxItem => ({
  key: `feedback:${id}`,
  conversationId: `conversation-${id}`,
  type: 'negative_feedback',
  severity: 'feedback',
  title: `Feedback ${id}`,
  detail: 'Sola',
  timestamp: '2026-06-19T10:00:00.000Z',
  assistantMessageId: id,
  triageState: 'open',
  triage: triage(),
  ...overrides,
})

const conflict = (current: QualityTriageRecord) => Object.assign(new Error('Quality triage changed'), {
  status: 409,
  error: { code: 'QUALITY_TRIAGE_CONFLICT', details: { current } },
})

describe('bulkDismissableItems', () => {
  it('keeps open and acknowledged feedback and nothing else', () => {
    const open = feedbackItem('a')
    const acknowledged = feedbackItem('b', { triageState: 'acknowledged', triage: triage({ state: 'acknowledged', version: 1 }) })
    const resolved = feedbackItem('c', { triageState: 'resolved' })
    const noTurn = feedbackItem('d', { assistantMessageId: undefined })
    const handoff: InboxItem = { ...feedbackItem('e'), type: 'handoff', severity: 'critical', assistantMessageId: undefined }
    const approval: InboxItem = { ...feedbackItem('f'), type: 'approval', severity: 'critical' }

    expect(bulkDismissableItems([open, acknowledged, resolved, noTurn, handoff, approval]))
      .toEqual([open, acknowledged])
  })
})

describe('runBulkDismiss', () => {
  it('dismisses every row through the single-row dismissal at the row\'s own version', async () => {
    const items = [
      feedbackItem('a', { triage: triage({ version: 0 }) }),
      feedbackItem('b', { triageState: 'acknowledged', triage: triage({ state: 'acknowledged', version: 3 }) }),
    ]
    const calls: Array<{ id: string; version: number }> = []

    const rows = await runBulkDismiss({
      items: bulkDismissableItems(items),
      dismiss: async (item) => {
        calls.push({ id: item.assistantMessageId, version: item.triage?.version ?? 0 })
        return triage({ state: 'dismissed', version: (item.triage?.version ?? 0) + 1 })
      },
    })

    expect(calls).toEqual([{ id: 'a', version: 0 }, { id: 'b', version: 3 }])
    expect(rows.map((row) => row.result.kind)).toEqual(['dismissed', 'dismissed'])
  })

  it('reports a row that fails on its own while the rest are dismissed', async () => {
    const items = bulkDismissableItems([feedbackItem('a'), feedbackItem('b'), feedbackItem('c')])
    const settled: string[] = []

    const rows = await runBulkDismiss({
      items,
      dismiss: async (item) => {
        if (item.assistantMessageId === 'b') throw Object.assign(new Error('boom'), { status: 500 })
        return triage({ state: 'dismissed', version: 1 })
      },
      onSettled: (row) => settled.push(`${row.item.assistantMessageId}:${row.result.kind}`),
    })

    expect(rows.map((row) => row.result.kind)).toEqual(['dismissed', 'failed', 'dismissed'])
    expect(rows[1]?.result).toEqual({ kind: 'failed', status: 500 })
    expect([...settled].sort()).toEqual(['a:dismissed', 'b:failed', 'c:dismissed'])
  })

  it('tells a row another operator already closed from one they only changed', async () => {
    const items = bulkDismissableItems([feedbackItem('a'), feedbackItem('b')])
    const closedByOther = triage({ state: 'resolved', version: 4 })
    const acknowledgedByOther = triage({ state: 'acknowledged', version: 2 })

    const rows = await runBulkDismiss({
      items,
      dismiss: async (item) => {
        throw conflict(item.assistantMessageId === 'a' ? closedByOther : acknowledgedByOther)
      },
    })

    expect(rows.map((row) => row.result)).toEqual([
      { kind: 'closed_elsewhere', current: closedByOther },
      { kind: 'changed', current: acknowledgedByOther },
    ])
  })

  it('never runs more reads at once than its concurrency', async () => {
    const items = bulkDismissableItems(Array.from({ length: 9 }, (_, index) => feedbackItem(String(index))))
    let active = 0
    let peak = 0

    await runBulkDismiss({
      items,
      concurrency: 3,
      dismiss: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return triage({ state: 'dismissed', version: 1 })
      },
    })

    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })
})

describe('summarizeBulkDismiss', () => {
  const row = (id: string, result: BulkDismissRowResult['result']): BulkDismissRowResult => ({
    item: { ...feedbackItem(id), assistantMessageId: id },
    result,
  })

  it('announces a clean run and leaves nothing to report', () => {
    const summary = summarizeBulkDismiss([
      row('a', { kind: 'dismissed', triage: triage({ state: 'dismissed' }) }),
      row('b', { kind: 'dismissed', triage: triage({ state: 'dismissed' }) }),
    ])

    expect(summary.announcement).toBe('Dismissed 2 feedback items.')
    expect(summary.needsAttention).toEqual([])
  })

  it('counts what was dismissed and lists each row that was not', () => {
    const failed = row('b', { kind: 'failed', status: 500 })
    const summary = summarizeBulkDismiss([
      row('a', { kind: 'dismissed', triage: triage({ state: 'dismissed' }) }),
      failed,
      row('c', { kind: 'closed_elsewhere', current: triage({ state: 'resolved' }) }),
    ])

    expect(summary.dismissed).toBe(1)
    expect(summary.needsAttention.map((entry) => entry.item.assistantMessageId)).toEqual(['b', 'c'])
    expect(summary.announcement).toBe('Dismissed 1 of 3 feedback items. 2 need a look.')
  })

  it('uses the singular for one item', () => {
    const summary = summarizeBulkDismiss([row('a', { kind: 'dismissed', triage: triage({ state: 'dismissed' }) })])

    expect(summary.announcement).toBe('Dismissed 1 feedback item.')
  })
})

describe('bulkDismissRowMessage', () => {
  it('gives each outcome its own message, and a refused permission its own', () => {
    expect(bulkDismissRowMessage({ kind: 'failed', status: 500 })).toBe('Could not dismiss. Try again.')
    expect(bulkDismissRowMessage({ kind: 'failed', status: 403 })).toBe('You do not have permission to dismiss feedback.')
    expect(bulkDismissRowMessage({ kind: 'changed', current: triage({ state: 'acknowledged' }) }))
      .toBe('Another operator changed it. Try again.')
    expect(bulkDismissRowMessage({ kind: 'closed_elsewhere', current: triage({ state: 'resolved' }) }))
      .toBe('Another operator already closed it.')
  })
})
