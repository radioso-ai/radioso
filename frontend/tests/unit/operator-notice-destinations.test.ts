import { describe, expect, it } from 'vitest'

import {
  defaultNoticeDestinationLabel,
  describeNoticeDestination,
  parseOperatorNoticeDestinations,
  type OperatorNoticeDestination,
  type OperatorNoticeDestinations,
} from '@/lib/operator-notice-destinations'

const destination = (overrides: Partial<OperatorNoticeDestination> = {}): OperatorNoticeDestination => ({
  skillName: null,
  via: 'workspace_owner',
  recipientEmails: ['owner@ananda.it'],
  recipientsFromWorkspaceOwner: true,
  webhookConfigured: false,
  ...overrides,
})

const destinations: OperatorNoticeDestinations = {
  default: destination(),
  skills: [destination({ skillName: 'notify_bookings', via: 'named_skill', recipientEmails: ['francesco@ananda.it', 'desk@ananda.it'], recipientsFromWorkspaceOwner: false })],
}

describe('describeNoticeDestination', () => {
  it('names the recipients of the default destination and of a named skill', () => {
    expect(describeNoticeDestination(destinations, undefined)).toBe('Sends to owner@ananda.it (workspace owner)')
    expect(describeNoticeDestination(destinations, 'notify_bookings')).toBe('Sends to francesco@ananda.it, desk@ananda.it')
  })

  it('mentions a webhook without naming it, and says when nothing is sent', () => {
    expect(describeNoticeDestination({ ...destinations, default: destination({ webhookConfigured: true }) }, undefined))
      .toBe('Sends to owner@ananda.it (workspace owner) and a webhook')
    expect(describeNoticeDestination({ ...destinations, default: destination({ recipientEmails: [], recipientsFromWorkspaceOwner: false, webhookConfigured: true, via: 'agent_setting' }) }, undefined))
      .toBe('Sends to a webhook')
    expect(describeNoticeDestination({ ...destinations, default: destination({ via: 'contact_human_off', recipientEmails: [], recipientsFromWorkspaceOwner: false }) }, undefined))
      .toBe('Not sent: contact_human is turned off')
    expect(describeNoticeDestination({ ...destinations, default: destination({ via: 'none', recipientEmails: [], recipientsFromWorkspaceOwner: false }) }, undefined))
      .toBe('Not sent: no recipient is set up')
  })

  it('says a skill that is no longer available falls back to the default destination', () => {
    expect(describeNoticeDestination(destinations, 'notify_gone')).toBe('Unavailable, so it sends to the default: owner@ananda.it (workspace owner)')
  })

  it('shows nothing until the destinations load', () => {
    expect(describeNoticeDestination(null, 'notify_bookings')).toBeNull()
  })
})

describe('defaultNoticeDestinationLabel', () => {
  it('names the rule the default destination follows', () => {
    expect(defaultNoticeDestinationLabel(destination())).toBe('Default (workspace owner)')
    expect(defaultNoticeDestinationLabel(destination({ via: 'contact_human' }))).toBe('Default (contact_human)')
    expect(defaultNoticeDestinationLabel(destination({ via: 'agent_setting' }))).toBe('Default (agent contact settings)')
    expect(defaultNoticeDestinationLabel(destination({ via: 'none' }))).toBe('Default')
    expect(defaultNoticeDestinationLabel(undefined)).toBe('Default')
  })
})

describe('parseOperatorNoticeDestinations', () => {
  it('reads the endpoint payload and rejects a malformed one', () => {
    expect(parseOperatorNoticeDestinations(destinations)).toEqual(destinations)
    expect(() => parseOperatorNoticeDestinations({ default: { via: 'carrier_pigeon' }, skills: [] })).toThrow()
    expect(() => parseOperatorNoticeDestinations({ skills: [] })).toThrow()
  })
})
