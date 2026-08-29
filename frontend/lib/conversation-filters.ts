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
