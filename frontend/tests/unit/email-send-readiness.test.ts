import { describe, expect, it } from 'vitest'

import type { ConversationEmailFacts } from '@/lib/api-email-channel'
import { emailSendUnavailableReason } from '@/lib/email-send-readiness'

const facts = (sending: ConversationEmailFacts['sending']['state']): ConversationEmailFacts => ({
  mailbox: { id: 'mailbox-1', address: 'support@customer.test', displayName: 'Support', engagementMode: 'draft' },
  participant: { address: 'ana@example.test', displayName: null },
  latest: { subject: null, cc: [], inboundAt: null },
  sending: { state: sending },
  sendBudget: { used: 0, limit: 3, renewedAt: null },
  messages: [],
})

describe('emailSendUnavailableReason', () => {
  it('is ready only when a successful read says the mailbox can send', () => {
    expect(emailSendUnavailableReason({ facts: facts('ok'), error: null })).toBeNull()
  })

  it('names what keeps a mailbox from sending', () => {
    expect(emailSendUnavailableReason({ facts: facts('not_verified'), error: null }))
      .toBe('Replies wait until this mailbox’s domain is verified.')
    expect(emailSendUnavailableReason({ facts: facts('domain_removed'), error: null }))
      .toBe('This mailbox’s sending domain was removed.')
  })

  it('waits while the mailbox has not been read yet', () => {
    expect(emailSendUnavailableReason({ facts: null, error: null })).toBe('Checking whether this mailbox can send.')
  })

  it('waits when the mailbox cannot be read, or its last read failed and what is held may be stale', () => {
    expect(emailSendUnavailableReason({ facts: null, error: 'Email details are unavailable.' }))
      .toBe('Can’t confirm this mailbox can send right now.')
    expect(emailSendUnavailableReason({ facts: facts('ok'), error: 'Email details are unavailable.' }))
      .toBe('Can’t confirm this mailbox can send right now.')
  })
})
