import { describe, expect, it } from 'vitest'

import {
  endOfDayIsoFromDateInput,
  getDocumentRetrievalState,
  isRetrievable,
  toDateInputValue,
} from '@/lib/document-retrieval'

const now = new Date('2026-07-16T12:00:00Z')

describe('getDocumentRetrievalState', () => {
  it('is included with no exclusion or expiry', () => {
    expect(getDocumentRetrievalState({ retrievalEnabled: true, retrievalExpiresAt: null }, now)).toBe('included')
  })

  it('is excluded when manually excluded, regardless of expiry', () => {
    expect(
      getDocumentRetrievalState({ retrievalEnabled: false, retrievalExpiresAt: '2999-01-01T00:00:00Z' }, now),
    ).toBe('excluded')
  })

  it('is expired when the expiry has passed', () => {
    expect(
      getDocumentRetrievalState({ retrievalEnabled: true, retrievalExpiresAt: '2020-01-01T00:00:00Z' }, now),
    ).toBe('expired')
  })

  it('is scheduled when the expiry is in the future', () => {
    expect(
      getDocumentRetrievalState({ retrievalEnabled: true, retrievalExpiresAt: '2027-01-01T00:00:00Z' }, now),
    ).toBe('scheduled')
  })
})

describe('isRetrievable', () => {
  it('is true for included and scheduled documents', () => {
    expect(isRetrievable({ retrievalEnabled: true, retrievalExpiresAt: null }, now)).toBe(true)
    expect(isRetrievable({ retrievalEnabled: true, retrievalExpiresAt: '2027-01-01T00:00:00Z' }, now)).toBe(true)
  })

  it('is false for excluded and expired documents', () => {
    expect(isRetrievable({ retrievalEnabled: false, retrievalExpiresAt: null }, now)).toBe(false)
    expect(isRetrievable({ retrievalEnabled: true, retrievalExpiresAt: '2020-01-01T00:00:00Z' }, now)).toBe(false)
  })
})

describe('date input conversion', () => {
  it('round-trips a local calendar date through end-of-day and back', () => {
    const iso = endOfDayIsoFromDateInput('2026-08-01')
    expect(iso).not.toBeNull()
    // The stored instant maps back to the same calendar day the user picked.
    expect(toDateInputValue(iso)).toBe('2026-08-01')
  })

  it('anchors the expiry to the end of the selected local day', () => {
    const iso = endOfDayIsoFromDateInput('2026-08-01')
    const date = new Date(iso as string)
    expect(date.getHours()).toBe(23)
    expect(date.getMinutes()).toBe(59)
  })

  it('returns null for empty or malformed input', () => {
    expect(endOfDayIsoFromDateInput('')).toBeNull()
    expect(endOfDayIsoFromDateInput('not-a-date')).toBeNull()
  })

  it('formats a null expiry as an empty date-input value', () => {
    expect(toDateInputValue(null)).toBe('')
  })
})
