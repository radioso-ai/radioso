import { describe, expect, it } from 'vitest'

import { filterConversations, type ConversationFilterState } from '@/lib/conversation-filters'
import { IN_PROGRESS_WINDOW_MS } from '@/lib/conversation-outcome'
import type { ChatConversationSummary } from '@/lib/api'

const NOW = new Date('2026-08-28T12:00:00.000Z')
const OLD_TIMESTAMP = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
const RECENT_TIMESTAMP = new Date(NOW.getTime() - 60 * 1000).toISOString()

const baseFilters: ConversationFilterState = {
  search: '',
  outcome: 'all',
  agentId: null,
  siteOrigin: null,
}

const conversation = (overrides: Partial<ChatConversationSummary> = {}): ChatConversationSummary => ({
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
  messageCount: 4,
  userMessageCount: 2,
  assistantMessageCount: 2,
  preview: 'Disponibilità del libro in inglese',
  ...overrides,
} as ChatConversationSummary)

describe('filterConversations', () => {
  it('passes everything when filters are at their defaults', () => {
    const conversations = [conversation({ id: 'a' }), conversation({ id: 'b' })]

    expect(filterConversations(conversations, baseFilters, NOW)).toHaveLength(2)
  })

  it('matches search case-insensitively against the markdown-stripped title', () => {
    const conversations = [
      conversation({ id: 'a', preview: 'Where can I find the **English** edition?' }),
      conversation({ id: 'b', preview: 'Orari dei corsi di yoga' }),
    ]

    const result = filterConversations(conversations, { ...baseFilters, search: 'english' }, NOW)

    expect(result.map((c) => c.id)).toEqual(['a'])
  })

  it('filters by outcome', () => {
    const handedOff = conversation({
      id: 'handed-off',
      updatedAt: RECENT_TIMESTAMP,
      ownership: {
        conversationId: 'handed-off',
        workspaceId: 'workspace-1',
        state: 'human_owned',
        ownerAccountId: null,
        ownerDisplayName: null,
        reason: null,
        version: 1,
        takenOverAt: RECENT_TIMESTAMP,
        createdAt: RECENT_TIMESTAMP,
        updatedAt: RECENT_TIMESTAMP,
      },
    })
    const inProgress = conversation({ id: 'in-progress', updatedAt: RECENT_TIMESTAMP })
    const completed = conversation({ id: 'completed', updatedAt: OLD_TIMESTAMP })
    const conversations = [handedOff, inProgress, completed]

    expect(filterConversations(conversations, { ...baseFilters, outcome: 'handed_off' }, NOW).map((c) => c.id)).toEqual([
      'handed-off',
    ])
    expect(filterConversations(conversations, { ...baseFilters, outcome: 'in_progress' }, NOW).map((c) => c.id)).toEqual([
      'in-progress',
    ])
    expect(filterConversations(conversations, { ...baseFilters, outcome: 'completed' }, NOW).map((c) => c.id)).toEqual([
      'completed',
    ])
  })

  it('filters by agentId, treating null as no filter', () => {
    const conversations = [
      conversation({ id: 'a', agentId: 'agent-1' }),
      conversation({ id: 'b', agentId: 'agent-2' }),
    ]

    expect(filterConversations(conversations, { ...baseFilters, agentId: 'agent-2' }, NOW).map((c) => c.id)).toEqual([
      'b',
    ])
    expect(filterConversations(conversations, { ...baseFilters, agentId: null }, NOW)).toHaveLength(2)
  })

  it('filters by siteOrigin, treating null as no filter', () => {
    const conversations = [
      conversation({ id: 'a', sourceOrigin: 'https://www.anandaedizioni.it' }),
      conversation({ id: 'b', sourceOrigin: 'https://corsi.ananda.it' }),
    ]

    expect(
      filterConversations(conversations, { ...baseFilters, siteOrigin: 'https://corsi.ananda.it' }, NOW).map(
        (c) => c.id,
      ),
    ).toEqual(['b'])
    expect(filterConversations(conversations, { ...baseFilters, siteOrigin: null }, NOW)).toHaveLength(2)
  })

  it('combines all filters with AND semantics', () => {
    const conversations = [
      conversation({
        id: 'match',
        preview: 'Recupero accesso',
        agentId: 'agent-1',
        sourceOrigin: 'https://www.anandaedizioni.it',
        updatedAt: OLD_TIMESTAMP,
      }),
      conversation({
        id: 'wrong-agent',
        preview: 'Recupero accesso',
        agentId: 'agent-2',
        sourceOrigin: 'https://www.anandaedizioni.it',
        updatedAt: OLD_TIMESTAMP,
      }),
      conversation({
        id: 'wrong-search',
        preview: 'Orari dei corsi',
        agentId: 'agent-1',
        sourceOrigin: 'https://www.anandaedizioni.it',
        updatedAt: OLD_TIMESTAMP,
      }),
      conversation({
        id: 'wrong-outcome',
        preview: 'Recupero accesso',
        agentId: 'agent-1',
        sourceOrigin: 'https://www.anandaedizioni.it',
        updatedAt: RECENT_TIMESTAMP,
      }),
    ]

    const result = filterConversations(
      conversations,
      {
        search: 'recupero',
        outcome: 'completed',
        agentId: 'agent-1',
        siteOrigin: 'https://www.anandaedizioni.it',
      },
      NOW,
    )

    expect(result.map((c) => c.id)).toEqual(['match'])
  })

  it('treats an in-window update as still matching an in_progress filter at the boundary', () => {
    const atBoundary = conversation({
      id: 'boundary',
      updatedAt: new Date(NOW.getTime() - IN_PROGRESS_WINDOW_MS).toISOString(),
    })

    expect(filterConversations([atBoundary], { ...baseFilters, outcome: 'in_progress' }, NOW)).toHaveLength(1)
  })
})
