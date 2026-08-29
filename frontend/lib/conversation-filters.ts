import type { ChatConversationSummary } from '@/lib/api'
import { deriveConversationOutcome, type ConversationOutcome } from '@/lib/conversation-outcome'
import { stripMarkdownSyntax } from '@/lib/markdown-preview'

export type OutcomeFilter = 'all' | ConversationOutcome['kind']

export interface ConversationFilterState {
  search: string
  outcome: OutcomeFilter
  agentId: string | null
  siteOrigin: string | null
}

export const EMPTY_CONVERSATION_FILTERS: ConversationFilterState = {
  search: '',
  outcome: 'all',
  agentId: null,
  siteOrigin: null,
}

/**
 * Client-side filtering for the Conversations toolbar (spec 1116). The
 * backend list endpoint (`chatApi.listChatHistory`) only accepts
 * `{ limit, offset }` — there is no server-side agent/outcome/site filter
 * today — so this only ever narrows whatever page of conversations is
 * already loaded; callers are responsible for noting that scope to
 * operators (or accepting it silently, as the toolbar does for now).
 */
export function filterConversations(
  conversations: ChatConversationSummary[],
  filters: ConversationFilterState,
  now: Date,
): ChatConversationSummary[] {
  const search = filters.search.trim().toLowerCase()

  return conversations.filter((conversation) => {
    if (search) {
      const title = stripMarkdownSyntax(conversation.preview || '').toLowerCase()
      if (!title.includes(search)) {
        return false
      }
    }

    if (filters.outcome !== 'all' && deriveConversationOutcome(conversation, now).kind !== filters.outcome) {
      return false
    }

    if (filters.agentId !== null && conversation.agentId !== filters.agentId) {
      return false
    }

    if (filters.siteOrigin !== null && conversation.sourceOrigin !== filters.siteOrigin) {
      return false
    }

    return true
  })
}

/**
 * The free-text half of the Conversations toolbar's search, reused for the
 * All lens's non-chat rows (search and contact history entries), which carry
 * no outcome/agent/site to filter on — only a title-ish preview string.
 */
export const matchesConversationSearchText = (text: string, search: string): boolean => {
  const query = search.trim().toLowerCase()
  return query.length === 0 || text.toLowerCase().includes(query)
}
