import { describe, expect, it } from 'vitest'

import type { HistoryListItem } from '@/components/dashboard/history/history-list'
import {
  buildAgentOptions,
  buildSiteOptions,
  filterAllLensItems,
} from '@/components/dashboard/inbox/all-conversations-list-pane'
import { EMPTY_CONVERSATION_FILTERS, type ConversationFilterState } from '@/lib/conversation-filters'
import type { ChatConversationSummary, ContactHistorySummary, DocumentSearchHistoryEntry } from '@/lib/api'

const chatConversation = (entry: HistoryListItem): ChatConversationSummary => {
  if (entry.kind !== 'chat') {
    throw new Error('expected a chat entry')
  }
  return entry.conversation
}

const NOW = new Date('2026-08-28T12:00:00.000Z')
const OLD_TIMESTAMP = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()

const chatEntry = (overrides: Partial<ChatConversationSummary> = {}): HistoryListItem => {
  const conversation: ChatConversationSummary = {
    id: 'conversation-1',
    agentId: 'agent-1',
    agentName: 'Gioia',
    agentInternalName: null,
    sourceChannel: 'website_embed',
    sourceOrigin: 'https://www.anandaedizioni.it',
    channelContext: null,
    anonymousSessionId: 'visitor-1',
    entryPageUrl: null,
    createdAt: OLD_TIMESTAMP,
    updatedAt: OLD_TIMESTAMP,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: 'Disponibilità del libro in inglese',
    ...overrides,
  } as ChatConversationSummary
  return { kind: 'chat', id: conversation.id, sortAt: conversation.updatedAt, conversation }
}

const searchEntry = (overrides: Partial<DocumentSearchHistoryEntry> = {}): HistoryListItem => {
  const search: DocumentSearchHistoryEntry = {
    searchId: 'search-1',
    query: 'orari corsi yoga',
    createdAt: OLD_TIMESTAMP,
    resultCount: 3,
    activityTraceAvailable: true,
    previewTopTitles: ['Orari corsi'],
    ...overrides,
  }
  return { kind: 'search', id: search.searchId, sortAt: search.createdAt, search }
}

const contactEntry = (overrides: Partial<ContactHistorySummary> = {}): HistoryListItem => {
  const contact: ContactHistorySummary = {
    id: 'contact-1',
    sortAt: OLD_TIMESTAMP,
    workspaceId: 'workspace-1',
    conversationId: 'conversation-contact-1',
    assistantMessageId: null,
    sourceChannel: 'website_embed',
    sourceOrigin: 'https://www.anandaedizioni.it',
    userEmail: 'visitor@example.com',
    messagePreview: 'Please call me back about my refund',
    triggerSource: 'assistant',
    triggerReason: null,
    status: 'delivered',
    attempts: 1,
    createdAt: OLD_TIMESTAMP,
    updatedAt: OLD_TIMESTAMP,
    ...overrides,
  }
  return { kind: 'contact', id: contact.id, sortAt: contact.sortAt, contact }
}

const filters = (overrides: Partial<ConversationFilterState> = {}): ConversationFilterState => ({
  ...EMPTY_CONVERSATION_FILTERS,
  ...overrides,
})

describe('filterAllLensItems', () => {
  it('passes every kind through when filters are at their defaults', () => {
    const items = [chatEntry(), searchEntry(), contactEntry()]

    expect(filterAllLensItems(items, filters(), NOW)).toHaveLength(3)
  })

  it('matches free-text search against a chat row\'s markdown-stripped title', () => {
    const items = [
      chatEntry({ id: 'a', preview: 'Where can I find the **English** edition?' }),
      chatEntry({ id: 'b', preview: 'Orari dei corsi di yoga' }),
    ]

    const result = filterAllLensItems(items, filters({ search: 'english' }), NOW)

    expect(result.map((entry) => entry.id)).toEqual(['a'])
  })

  it('matches free-text search against a chat row\'s generated title when one exists, even if the preview differs', () => {
    const items = [
      chatEntry({ id: 'a', title: 'Refund for order 4821', preview: 'hey' }),
      chatEntry({ id: 'b', title: null, preview: 'Orari dei corsi di yoga' }),
    ]

    const result = filterAllLensItems(items, filters({ search: 'refund' }), NOW)

    expect(result.map((entry) => entry.id)).toEqual(['a'])
  })

  it('matches free-text search against a search row\'s query and a contact row\'s preview', () => {
    const items = [
      searchEntry({ query: 'audiobook download' }),
      contactEntry({ messagePreview: 'refund for a duplicate order' }),
    ]

    expect(filterAllLensItems(items, filters({ search: 'audiobook' }), NOW).map((e) => e.kind)).toEqual(['search'])
    expect(filterAllLensItems(items, filters({ search: 'refund' }), NOW).map((e) => e.kind)).toEqual(['contact'])
  })

  it('narrows to chat rows only once an outcome filter is set, since only chats have an outcome', () => {
    const items = [chatEntry({ id: 'chat-1' }), searchEntry(), contactEntry()]

    const result = filterAllLensItems(items, filters({ outcome: 'completed' }), NOW)

    expect(result).toEqual([chatEntry({ id: 'chat-1' })])
  })

  it('narrows to chat rows only once an agent filter is set', () => {
    const items = [chatEntry({ id: 'chat-1', agentId: 'agent-1' }), searchEntry(), contactEntry()]

    const result = filterAllLensItems(items, filters({ agentId: 'agent-1' }), NOW)

    expect(result.map((entry) => entry.kind)).toEqual(['chat'])
  })

  it('narrows to chat rows only once a site filter is set', () => {
    const items = [chatEntry({ id: 'chat-1', sourceOrigin: 'https://www.anandaedizioni.it' }), searchEntry(), contactEntry()]

    const result = filterAllLensItems(items, filters({ siteOrigin: 'https://www.anandaedizioni.it' }), NOW)

    expect(result.map((entry) => entry.kind)).toEqual(['chat'])
  })
})

describe('buildAgentOptions / buildSiteOptions', () => {
  it('stay stable while a filter is active — options must be built from the unfiltered page, not the filtered rows', () => {
    const items = [
      chatEntry({ id: 'a', agentId: 'agent-1', agentName: 'Gioia', sourceOrigin: 'https://www.anandaedizioni.it', preview: 'Recupero accesso' }),
      chatEntry({ id: 'b', agentId: 'agent-2', agentName: 'Claudio', sourceOrigin: 'https://corsi.ananda.it', preview: 'Orari corsi yoga' }),
    ]
    const unfilteredConversations = items.map(chatConversation)

    // An active search filter narrows the visible rows to just "a"...
    const visibleRows = filterAllLensItems(items, filters({ search: 'recupero' }), NOW)
    expect(visibleRows.map((entry) => entry.id)).toEqual(['a'])

    // ...but the dropdown options, built from the unfiltered page the caller
    // holds onto separately, must still offer both agents and both sites —
    // including agent-2/corsi.ananda.it, which the active filter hides from
    // the row list but must not hide from the filter itself.
    expect(buildAgentOptions(unfilteredConversations)).toEqual([
      { agentId: 'agent-1', label: 'Gioia' },
      { agentId: 'agent-2', label: 'Claudio' },
    ])
    expect(buildSiteOptions(unfilteredConversations)).toEqual([
      'https://www.anandaedizioni.it',
      'https://corsi.ananda.it',
    ])
  })

  it('would silently drop an option if built from the filtered rows instead (the regression this guards against)', () => {
    const items = [
      chatEntry({ id: 'a', agentId: 'agent-1', agentName: 'Gioia', preview: 'Recupero accesso' }),
      chatEntry({ id: 'b', agentId: 'agent-2', agentName: 'Claudio', preview: 'Orari corsi yoga' }),
    ]

    const visibleRows = filterAllLensItems(items, filters({ search: 'recupero' }), NOW)
    const optionsFromFilteredRows = buildAgentOptions(visibleRows.map(chatConversation))

    expect(optionsFromFilteredRows).toEqual([{ agentId: 'agent-1', label: 'Gioia' }])
  })
})
