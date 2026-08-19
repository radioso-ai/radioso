import { afterEach, describe, expect, it, vi } from 'vitest'

import { relativeTimestamp } from '@/lib/relative-time'

describe('relativeTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances the displayed unit at each threshold', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'))

    expect(relativeTimestamp('2026-08-12T11:58:30.000Z')).toMatch(/minute/)
    expect(relativeTimestamp('2026-08-12T10:00:00.000Z')).toMatch(/hour/)
    expect(relativeTimestamp('2026-08-10T12:00:00.000Z')).toMatch(/day/)
    expect(relativeTimestamp('2026-07-29T12:00:00.000Z')).toMatch(/week/)
  })

  it('returns unparseable timestamps unchanged', () => {
    expect(relativeTimestamp('not-a-date')).toBe('not-a-date')
  })
})
