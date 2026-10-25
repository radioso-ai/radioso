import { describe, expect, it } from 'vitest'

import { credentialExpiryRequest } from '@/components/dashboard/settings/credential-expiry-field'

const now = new Date('2026-10-25T09:00:00.000Z')

describe('credentialExpiryRequest', () => {
  it('asks for a credential that never expires', () => {
    expect(credentialExpiryRequest({ mode: 'never', date: '2027-01-01' }, now)).toEqual({ valid: true, expiresAt: null })
  })

  it('turns a chosen date into the start of that day in UTC', () => {
    expect(credentialExpiryRequest({ mode: 'date', date: '2027-01-01' }, now)).toEqual({ valid: true, expiresAt: '2027-01-01T00:00:00.000Z' })
  })

  it('holds the request back while the chosen date is empty', () => {
    expect(credentialExpiryRequest({ mode: 'date', date: '' }, now)).toEqual({ valid: false })
  })

  it('holds the request back for a date that has already started', () => {
    expect(credentialExpiryRequest({ mode: 'date', date: '2026-10-25' }, now)).toEqual({ valid: false })
    expect(credentialExpiryRequest({ mode: 'date', date: '2026-10-01' }, now)).toEqual({ valid: false })
  })
})
