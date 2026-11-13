import { describe, expect, it } from 'vitest'

import type { ChatConversationMessage, ConversationConsent } from '@/lib/api-types'
import {
  WITHHELD_MESSAGE_LABEL,
  canWithdrawConsent,
  consentAfterRefusedWithdrawal,
  consentStatus,
  withConsent,
  withheldMessageView,
} from '@/lib/conversation-consents'

const consent = (overrides: Partial<ConversationConsent> = {}): ConversationConsent => ({
  id: 'record-1',
  routineId: 'routine-class-booking',
  consentKey: 'health',
  slotKeys: ['injury'],
  decision: 'granted',
  method: 'button',
  defaulted: false,
  locale: 'en',
  channel: 'website_embed',
  wordingVersionId: 'wording-1',
  wording: { body: 'We ask about injuries only to adapt your class.', agreeLabel: 'I agree', declineLabel: 'No thanks' },
  decidedAt: '2026-11-10T09:00:00.000Z',
  withdrawnAt: null,
  ...overrides,
})

describe('consent status', () => {
  it('reads a granted consent as withdrawable until it is withdrawn', () => {
    expect(consentStatus(consent())).toBe('granted')
    expect(canWithdrawConsent(consent())).toBe(true)

    const withdrawn = consent({ withdrawnAt: '2026-11-12T10:00:00.000Z' })
    expect(consentStatus(withdrawn)).toBe('withdrawn')
    expect(canWithdrawConsent(withdrawn)).toBe(false)
  })

  it('never offers to withdraw a declined consent', () => {
    const declined = consent({ decision: 'declined', defaulted: true })
    expect(consentStatus(declined)).toBe('declined')
    expect(canWithdrawConsent(declined)).toBe(false)
  })
})

describe('withConsent', () => {
  it('replaces the record the server answered with and keeps the others in place', () => {
    const first = consent()
    const second = consent({ id: 'record-2', consentKey: 'diet' })
    const withdrawn = { ...first, withdrawnAt: '2026-11-12T10:00:00.000Z' }

    expect(withConsent([first, second], withdrawn)).toEqual([withdrawn, second])
  })
})

describe('consentAfterRefusedWithdrawal', () => {
  it('reads the record as it stands from a 409 refusal', () => {
    const current = consent({ withdrawnAt: '2026-11-11T08:00:00.000Z' })
    const refusal = {
      status: 409,
      error: { code: 'consent_not_withdrawable', message: 'This consent is already withdrawn', details: { reason: 'already_withdrawn', consent: current } },
    }

    expect(consentAfterRefusedWithdrawal(refusal)).toEqual(current)
  })

  it('reads nothing from any other error', () => {
    expect(consentAfterRefusedWithdrawal({ status: 404, error: { code: 'not_found', message: 'Consent record not found' } })).toBeNull()
    expect(consentAfterRefusedWithdrawal(new Error('offline'))).toBeNull()
  })
})

describe('withheldMessageView', () => {
  const message = (overrides: Partial<ChatConversationMessage> = {}): ChatConversationMessage => ({
    id: 'message-1',
    role: 'user',
    source: 'customer',
    content: 'I have a sore knee',
    createdAt: '2026-11-10T09:01:00.000Z',
    ...overrides,
  })

  it('shows a withheld message as withheld rather than as its marker', () => {
    const withheld = message({ content: '[redacted]', withheld: { reason: 'consent_withdrawn', at: '2026-11-12T10:00:00.000Z' } })

    expect(withheldMessageView(withheld)).toEqual({ ...withheld, content: WITHHELD_MESSAGE_LABEL })
  })

  it('leaves every other message as it is', () => {
    const plain = message()
    expect(withheldMessageView(plain)).toBe(plain)
  })
})
