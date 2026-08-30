import { describe, expect, it } from 'vitest'

import type { ChatConversationSummary, ConversationOwnership } from '@/lib/api'
import {
  doneControlTooltip,
  findFirstVisitorMessage,
  informativeChannelLabel,
  readOnlyHandledByLabel,
  resolveReadOnlySource,
  selectSituationBody,
  stripTrackingParams,
  visitorIdentityLabel,
  type ReadOnlySourceDetail,
} from '@/lib/inbox-response'

const ownership = (overrides: Partial<ConversationOwnership> = {}): ConversationOwnership => ({
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  state: 'human_owned',
  ownerAccountId: 'account-1',
  ownerDisplayName: 'Anna',
  reason: null,
  version: 1,
  takenOverAt: '2026-06-19T10:00:00.000Z',
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  ...overrides,
})

const rowSummary = (overrides: Partial<ChatConversationSummary> = {}): ChatConversationSummary => ({
  id: 'conversation-1',
  agentId: 'agent-1',
  agentName: 'Marta',
  agentInternalName: null,
  sourceChannel: 'authenticated_chat',
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: 'session-1',
  entryPageUrl: null,
  title: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview: 'Please help with this order',
  ...overrides,
})

const detail = (overrides: Partial<ReadOnlySourceDetail> = {}): ReadOnlySourceDetail => ({
  conversationId: 'conversation-1',
  ownership: undefined,
  title: null,
  updatedAt: '2026-06-19T10:05:00.000Z',
  agentId: 'agent-1',
  agentName: 'Marta',
  agentInternalName: null,
  ...overrides,
})

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

describe('resolveReadOnlySource', () => {
  it('falls back to the row summary before the detail has loaded', () => {
    const row = rowSummary({ ownership: ownership() })

    expect(resolveReadOnlySource(row, null)).toBe(row)
  })

  it('returns null when neither the row summary nor the detail is available', () => {
    expect(resolveReadOnlySource(undefined, null)).toBeNull()
  })

  it('prefers a loaded detail that shows the conversation was just claimed, over a stale unowned row summary', () => {
    // The row summary was fetched before the handoff was claimed (no
    // ownership); the detail, fetched after, reflects the claim. The stale
    // hint must not keep this rendering read-only.
    const row = rowSummary({ ownership: undefined })
    const loaded = detail({ ownership: ownership({ ownerAccountId: 'account-2', ownerDisplayName: 'Ben' }) })

    expect(resolveReadOnlySource(row, loaded)?.ownership?.ownerDisplayName).toBe('Ben')
  })

  it('prefers a loaded detail that shows the conversation was handed back, over a stale owned row summary', () => {
    // The reverse case: the row summary still shows the old human owner: the
    // detail, fetched after a hand-back, carries no ownership at all. The
    // stale hint must not keep this rendering actionable as if still owned.
    const row = rowSummary({ ownership: ownership() })
    const loaded = detail({ ownership: undefined })

    expect(resolveReadOnlySource(row, loaded)?.ownership).toBeUndefined()
  })

  it('carries anonymousSessionId and preview over from the row summary once detail loads, since the detail response has neither', () => {
    const row = rowSummary({ anonymousSessionId: 'session-42', preview: 'Where is my order?' })
    const loaded = detail()

    const resolved = resolveReadOnlySource(row, loaded)
    expect(resolved?.anonymousSessionId).toBe('session-42')
    expect(resolved?.preview).toBe('Where is my order?')
  })

  it('resolves the detail-derived source even with no row summary at all (a deep link)', () => {
    const loaded = detail({ ownership: ownership() })

    expect(resolveReadOnlySource(undefined, loaded)).toMatchObject({
      id: 'conversation-1',
      ownership: loaded.ownership,
      anonymousSessionId: undefined,
      preview: undefined,
    })
  })
})
