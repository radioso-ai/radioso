'use client'

import { useEffect, useState } from 'react'

import { chatApi } from '@/lib/api-chat'
import { countAiHandledConversationsByAgent, withinLastDays, type AgentHandledCount } from '@/lib/needs-attention'

const CONFIDENCE_WINDOW_DAYS = 7
/**
 * One bounded page of recent history is enough for an empty-state confidence
 * summary — this is reassurance copy, not an analytics count, so it
 * deliberately doesn't paginate to exhaustion (there is no server-side
 * date-range filter to page against efficiently either).
 */
const CONFIDENCE_SAMPLE_SIZE = 100

export interface InboxConfidenceSummary {
  status: 'loading' | 'ready' | 'error'
  topAgent: AgentHandledCount | null
}

/** The empty-queue confidence summary's data source (FR-014): the agent that handled the most conversations without a human in the last 7 days, from a bounded recent-history sample. */
export const useInboxConfidenceSummary = (enabled: boolean): InboxConfidenceSummary => {
  const [state, setState] = useState<InboxConfidenceSummary>({ status: 'loading', topAgent: null })

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setState({ status: 'loading', topAgent: null })
      }
    })

    void chatApi.listChatHistory({ limit: CONFIDENCE_SAMPLE_SIZE, offset: 0 })
      .then((response) => {
        if (cancelled) {
          return
        }
        const now = new Date()
        const windowed = response.conversations.filter(
          (conversation) => withinLastDays(conversation.createdAt, CONFIDENCE_WINDOW_DAYS, now),
        )
        const counts = countAiHandledConversationsByAgent(windowed)
        setState({ status: 'ready', topAgent: counts[0] ?? null })
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error', topAgent: null })
        }
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}
