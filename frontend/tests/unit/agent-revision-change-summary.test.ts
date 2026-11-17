import { describe, expect, it } from 'vitest'

import { changedFields, revisionDisplayLabel, summarizeChangeValue } from '@/lib/agent-revision-change-summary'

describe('agent revision change summary', () => {
  it('collapses structured values instead of printing JSON', () => {
    expect(summarizeChangeValue([{ id: 'a' }, { id: 'b' }])).toBe('2 items')
    expect(summarizeChangeValue([{ id: 'a' }])).toBe('1 item')
    expect(summarizeChangeValue({ kind: 'always' })).toBe('Set')
    expect(summarizeChangeValue(null)).toBe('None')
    expect(summarizeChangeValue(5)).toBe('5')
  })

  it('lists only the routine parts that differ', () => {
    expect(changedFields(
      { steps: [1], transitions: [1], priority: 1 },
      { steps: [1, 2], transitions: [1], priority: 1 },
    )).toEqual(['steps'])
  })

  it('formats a draft label from its timestamp and keeps published labels', () => {
    const label = revisionDisplayLabel({ kind: 'candidate', label: 'Draft · 2026-11-18T10:00:00.000Z', createdAt: '2026-11-18T10:00:00.000Z' })
    expect(label.startsWith('Draft · ')).toBe(true)
    expect(label).not.toContain('T10:00:00')
    expect(revisionDisplayLabel({ kind: 'published', label: 'v3', createdAt: '2026-11-18T10:00:00.000Z' })).toBe('v3')
  })
})
