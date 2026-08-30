'use client'

import { useEffect, useState } from 'react'

import { chatApi } from '@/lib/api-chat'
import { summarizeAiHandledConversations, withinLastDays } from '@/lib/needs-attention'

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
  /** Total AI-handled conversations across every agent in the window; null while loading or on error. */
  totalCount: number | null
  /** Distinct agents that handled at least one; null while loading or on error. */
  agentCount: number | null
}

const EMPTY_SUMMARY = { totalCount: null, agentCount: null }

/**
 * The empty-queue confidence summary's data source (FR-014): the workspace-level
 * total of conversations handled without a human in the last 7 days (and how many
 * distinct agents contributed), from a bounded recent-history sample. Workspace-level
 * rather than naming one agent — the Inbox spans every agent, not just the busiest one.
 */
export const useInboxConfidenceSummary = (enabled: boolean): InboxConfidenceSummary => {
  const [state, setState] = useState<InboxConfidenceSummary>({ status: 'loading', ...EMPTY_SUMMARY })

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setState({ status: 'loading', ...EMPTY_SUMMARY })
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
        const summary = summarizeAiHandledConversations(windowed)
        setState({ status: 'ready', totalCount: summary.totalCount, agentCount: summary.agentCount })
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error', ...EMPTY_SUMMARY })
        }
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}
