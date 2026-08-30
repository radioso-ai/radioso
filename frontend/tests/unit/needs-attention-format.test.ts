import { describe, expect, it } from 'vitest'

import { formatInboxRowTimestamp } from '@/lib/needs-attention-format'

describe('formatInboxRowTimestamp', () => {
  it('is deterministic for the same instant', () => {
    const value = '2026-08-26T16:40:00.000Z'
    expect(formatInboxRowTimestamp(value)).toBe(formatInboxRowTimestamp(value))
  })

  it('renders a non-empty, locale-formatted day and time', () => {
    // Not asserting an exact string — the format is Intl.DateTimeFormat(undefined, ...),
    // so it adapts to the runtime's locale. This checks the shape: a day-of-month
    // number and a time separator are present, proving both date and time render.
    const formatted = formatInboxRowTimestamp('2026-08-26T16:40:00.000Z')
    expect(formatted.length).toBeGreaterThan(0)
    expect(formatted).toMatch(/26/)
    expect(formatted).toMatch(/:/)
  })

  it('produces different output for different instants', () => {
    const morning = formatInboxRowTimestamp('2026-08-26T09:00:00.000Z')
    const evening = formatInboxRowTimestamp('2026-08-26T21:00:00.000Z')
    expect(morning).not.toBe(evening)
  })
})
