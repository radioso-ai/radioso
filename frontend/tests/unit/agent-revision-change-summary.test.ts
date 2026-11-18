import { describe, expect, it } from 'vitest'

import { changedFields, summarizeChange } from '@/lib/agent-revision-change-summary'
import { revisionDisplayLabel } from '@/lib/agent-revision-label'

describe('agent revision change summary', () => {
  it('shows a directive condition by its description, so an edit reads differently before and after', () => {
    const summary = summarizeChange(
      { kind: 'when', description: 'Visitor asks about prices' },
      { kind: 'when', description: 'Visitor asks about discounts' },
    )
    expect(summary).toEqual({ before: 'Visitor asks about prices', after: 'Visitor asks about discounts' })
    expect(summarizeChange({ kind: 'always' }, { kind: 'always' }).after).toBe('Always')
  })

  it('shows a routine trigger edit with its description and priority', () => {
    const summary = summarizeChange(
      { triggerDescription: 'Wants to book', priority: 5, reentryMode: 'once_per_conversation' },
      { triggerDescription: 'Wants to reschedule', priority: 5, reentryMode: 'once_per_conversation' },
    )
    expect(summary.before).toContain('Wants to book')
    expect(summary.after).toContain('Wants to reschedule')
  })

  it('counts added, edited and removed steps by id, including a same-count edit', () => {
    const before = [{ id: 'a', text: 'Ask name' }, { id: 'b', text: 'Ask email' }]
    expect(summarizeChange(before, [{ id: 'a', text: 'Ask full name' }, { id: 'b', text: 'Ask email' }]).after)
      .toBe('2 items: 1 edited')
    expect(summarizeChange(before, [{ id: 'a', text: 'Ask name' }, { id: 'c', text: 'Confirm' }]).after)
      .toBe('2 items: 1 added, 1 removed')
  })

  it('lists only the parts that differ, including slots and name', () => {
    expect(changedFields(
      { name: 'Booking', slots: [], steps: [1], priority: 1 },
      { name: 'Booking', slots: [{ key: 'email' }], steps: [1], priority: 1 },
    )).toEqual(['slots'])
    expect(changedFields({ name: 'A' }, { name: 'B' })).toEqual(['name'])
  })

  it('formats a draft label from its timestamp and keeps published labels', () => {
    const base = { id: 'r1', label: 'Draft · 2026-11-18T10:00:00.000Z', createdAt: '2026-11-18T10:00:00.000Z' }
    const label = revisionDisplayLabel({ ...base, kind: 'candidate', versionNumber: null })
    expect(label.startsWith('Draft · ')).toBe(true)
    expect(label).not.toContain('T10:00:00')
    expect(revisionDisplayLabel({ ...base, kind: 'published', versionNumber: 3 })).toBe('v3')
  })
})
