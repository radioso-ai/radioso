import { describe, expect, it } from 'vitest'

import {
  doneControlTooltip,
  findFirstVisitorMessage,
  informativeChannelLabel,
  readOnlyHandledByLabel,
  selectSituationBody,
  stripTrackingParams,
  visitorIdentityLabel,
} from '@/lib/inbox-response'

describe('visitorIdentityLabel', () => {
  it('labels a session-backed visitor as anonymous', () => {
    expect(visitorIdentityLabel({ anonymousSessionId: 'session-1' })).toBe('Anonymous visitor')
  })

  it('labels a visitor without an anonymous session as verified', () => {
    expect(visitorIdentityLabel({ anonymousSessionId: null })).toBe('Verified visitor')
  })

  it('labels an unknown session state generically rather than guessing', () => {
    expect(visitorIdentityLabel({ anonymousSessionId: undefined })).toBe('Visitor')
  })
})

describe('stripTrackingParams', () => {
  it('removes utm_* parameters', () => {
    expect(stripTrackingParams('https://example.com/page?utm_source=newsletter&utm_medium=email'))
      .toBe('https://example.com/page')
  })

  it('removes known click-id parameters', () => {
    expect(stripTrackingParams('https://example.com/page?gclid=abc123&fbclid=xyz789'))
      .toBe('https://example.com/page')
  })

  it('keeps non-tracking query parameters', () => {
    expect(stripTrackingParams('https://example.com/page?category=yoga&utm_source=newsletter'))
      .toBe('https://example.com/page?category=yoga')
  })

  it('leaves a URL with no tracking parameters unchanged', () => {
    expect(stripTrackingParams('https://example.com/categoria/yoga'))
      .toBe('https://example.com/categoria/yoga')
  })

  it('returns non-parseable input unchanged instead of throwing', () => {
    expect(stripTrackingParams('not a url')).toBe('not a url')
  })
})

describe('informativeChannelLabel', () => {
  it('labels a Slack channel', () => {
    expect(informativeChannelLabel({
      provider: 'slack',
      team: { id: 'T1' },
      channel: { id: 'C1', type: 'channel' },
      user: { id: 'U1' },
    })).toBe('Slack')
  })

  it('does not label the default web embed', () => {
    expect(informativeChannelLabel({ provider: 'web' })).toBeNull()
  })

  it('does not label a missing channel context', () => {
    expect(informativeChannelLabel(null)).toBeNull()
    expect(informativeChannelLabel(undefined)).toBeNull()
  })
})

describe('selectSituationBody', () => {
  it('prefers the rolling summary when present', () => {
    expect(selectSituationBody({
      handoffReason: 'No schedule info',
      summary: 'Visitor wants the weekly yoga schedule.',
      firstVisitorMessage: 'dove trovo gli orari dei corsi di yoga',
    })).toBe('Visitor wants the weekly yoga schedule.')
  })

  it('falls back to the first visitor message when the summary is missing', () => {
    expect(selectSituationBody({
      handoffReason: null,
      summary: null,
      firstVisitorMessage: 'dove trovo gli orari dei corsi di yoga',
    })).toBe('dove trovo gli orari dei corsi di yoga')
  })

  it('falls back when the summary field is entirely absent', () => {
    expect(selectSituationBody({
      handoffReason: null,
      firstVisitorMessage: 'Hello',
    })).toBe('Hello')
  })

  it('returns null when neither source is available', () => {
    expect(selectSituationBody({ handoffReason: null, summary: null, firstVisitorMessage: null })).toBeNull()
  })
})

describe('findFirstVisitorMessage', () => {
  it('finds the first customer-sourced message', () => {
    const messages = [
      { source: 'ai_agent', role: 'assistant', content: 'Ciao, come posso aiutarti?' },
      { source: 'customer', role: 'user', content: 'dove trovo gli orari' },
      { source: 'ai_agent', role: 'assistant', content: 'Contatta la reception.' },
    ]

    expect(findFirstVisitorMessage(messages)).toBe('dove trovo gli orari')
  })

  it('falls back to role user when source is absent', () => {
    const messages = [
      { role: 'assistant', content: 'Ciao' },
      { role: 'user', content: 'Ho una domanda' },
    ]

    expect(findFirstVisitorMessage(messages)).toBe('Ho una domanda')
  })

  it('returns null when there is no visitor message', () => {
    expect(findFirstVisitorMessage([{ source: 'ai_agent', role: 'assistant', content: 'Ciao' }])).toBeNull()
  })
})

describe('readOnlyHandledByLabel', () => {
  it('names the agent that handled the conversation', () => {
    expect(readOnlyHandledByLabel({
      agentId: 'agent-1',
      agentName: 'Gioia',
      agentInternalName: null,
    })).toBe('handled by Gioia')
  })

  it('prefers the internal operator label over the public agent name', () => {
    expect(readOnlyHandledByLabel({
      agentId: 'agent-1',
      agentName: 'Claudio',
      agentInternalName: 'Website support',
    })).toBe('handled by Website support')
  })

  it('prefers a durable human closure record when one is present', () => {
    expect(readOnlyHandledByLabel({
      ownership: { ownerDisplayName: 'Anna' },
      agentId: 'agent-1',
      agentName: 'Gioia',
      agentInternalName: null,
    })).toBe('handled by Anna')
  })

  it('returns null rather than inventing attribution when no agent is known', () => {
    expect(readOnlyHandledByLabel({ agentId: null, agentName: null, agentInternalName: null })).toBeNull()
  })

  it('falls back to a generic agent label when the agent has no resolvable name', () => {
    expect(readOnlyHandledByLabel({ agentId: 'agent-1', agentName: null, agentInternalName: null }))
      .toBe('handled by the agent')
  })
})

describe('doneControlTooltip', () => {
  it('names the agent for a handoff', () => {
    expect(doneControlTooltip({ type: 'handoff', agentName: 'Gioia', agentInternalName: null }))
      .toBe('Closes this item and hands the conversation back to Gioia')
  })

  it('falls back to a generic agent label for a handoff with no agent name', () => {
    expect(doneControlTooltip({ type: 'handoff', agentName: null, agentInternalName: null }))
      .toBe('Closes this item and hands the conversation back to the agent')
  })

  it('describes triage closure for feedback', () => {
    expect(doneControlTooltip({ type: 'negative_feedback' }))
      .toBe('Closes this item once you resolve or dismiss the feedback')
  })
})
