import { describe, expect, it } from 'vitest'

import { formatInboxRowTimestamp, inboxOwnerPresentation } from '@/lib/needs-attention-format'

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

describe('inboxOwnerPresentation', () => {
  const dana = { userId: 'user-dana', label: 'Dana Scully' }

  it('says nothing for a conversation nobody holds', () => {
    expect(inboxOwnerPresentation(null, 'user-me')).toBeNull()
    expect(inboxOwnerPresentation(undefined, 'user-me')).toBeNull()
  })

  it('tells a conversation I hold from one a teammate holds, in words as well as kind', () => {
    const mine = inboxOwnerPresentation({ userId: 'user-me', label: 'Me Myself' }, 'user-me')
    const theirs = inboxOwnerPresentation(dana, 'user-me')

    expect(mine).toEqual({ kind: 'mine', text: 'You are handling this' })
    expect(theirs).toEqual({ kind: 'teammate', text: 'Dana Scully is handling this' })
  })

  it('does not name a holder it has no label for as someone in particular', () => {
    expect(inboxOwnerPresentation({ userId: 'user-dana', label: null }, 'user-me'))
      .toEqual({ kind: 'teammate', text: 'A teammate is handling this' })
  })

  it('does not call a holder a teammate until the signed-in teammate is known', () => {
    expect(inboxOwnerPresentation(dana, null)).toEqual({ kind: 'unknown', text: 'Dana Scully is handling this' })
    expect(inboxOwnerPresentation({ userId: 'user-dana', label: null }, null))
      .toEqual({ kind: 'unknown', text: 'Someone is handling this' })
  })
})
