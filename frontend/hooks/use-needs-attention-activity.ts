'use client'

import { useEffect, useState } from 'react'

import { chatApi, qualityApi, type LowQualityTurn, type QualityActionFilter } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import { ACTIVE_TRIAGE_STATES } from '@/lib/quality-signals'
import {
  HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
  countNewInboxItems,
  inboxItemKeys,
  selectHumanOwnedConversations,
} from '@/lib/needs-attention'

interface UseNeedsAttentionActivityInput {
  /** Per-item keys of the inbox state currently shown to the operator (see `inboxItemKeys`). */
  baselineKeys: readonly string[] | null
  /** Grounding-gap actions from the skills catalog; undefined means the catalog is unavailable. */
  qualityActions?: readonly QualityActionFilter[]
  enabled?: boolean
  /** Poll cadence while the tab is in the foreground. */
  intervalMs?: number
  /** Slower poll cadence while the tab is backgrounded (document hidden). */
  backgroundIntervalMs?: number
}

/**
 * Quietly polls the inbox endpoints in the background and returns how many items are new since the
 * operator last refreshed. It never replaces the displayed list — the view surfaces a manual refresh
 * affordance (with this count) so the operator is never interrupted mid-read. When the view
 * refreshes, `baselineKeys` updates and the count drops back to zero.
 *
 * Polling continues while backgrounded, but at the slower `backgroundIntervalMs` cadence; returning
 * to the foreground polls immediately (then resumes the foreground interval) so a stale tab catches
 * up the moment the operator looks at it again.
 */
export const useNeedsAttentionActivity = ({
  baselineKeys,
  qualityActions,
  enabled = true,
  intervalMs = 15000,
  backgroundIntervalMs = 30000,
}: UseNeedsAttentionActivityInput): number => {
  const [latestKeys, setLatestKeys] = useState<string[] | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let latestDecisions: Parameters<typeof inboxItemKeys>[0] = []
    let latestConversations: Parameters<typeof inboxItemKeys>[1] = []
    let latestQualityTurns: LowQualityTurn[] = []

    const isDocumentVisible = () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden'

    const nextDelay = () => (isDocumentVisible() ? intervalMs : backgroundIntervalMs)

    const clearPending = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
    }

    const scheduleNextPoll = () => {
      clearPending()
      if (cancelled) {
        return
      }
      timeoutId = setTimeout(poll, nextDelay())
    }

    const poll = async () => {
      const qualityRequest = qualityActions && qualityActions.length > 0
        ? qualityApi.listTurns({
            actions: [...qualityActions],
            triageStates: [...ACTIVE_TRIAGE_STATES],
            limit: 25,
          })
        : null
      const [approvalsResult, conversationsResult, qualityResult] = await Promise.allSettled([
        hitlApi.listPendingDecisions(),
        chatApi.listChatHistory({ limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE, offset: 0 }),
        qualityRequest ?? Promise.resolve(null),
      ])
      if (cancelled) {
        return
      }

      let hasFreshSource = false
      if (approvalsResult.status === 'fulfilled') {
        latestDecisions = approvalsResult.value.decisions
        hasFreshSource = true
      }
      if (conversationsResult.status === 'fulfilled') {
        latestConversations = selectHumanOwnedConversations(conversationsResult.value.conversations)
        hasFreshSource = true
      }
      if (qualityResult.status === 'fulfilled') {
        if (qualityResult.value) {
          latestQualityTurns = qualityResult.value.items
          hasFreshSource = true
        } else if (qualityActions !== undefined) {
          latestQualityTurns = []
        }
      }

      if (hasFreshSource) {
        setLatestKeys(inboxItemKeys(latestDecisions, latestConversations, latestQualityTurns))
      }

      scheduleNextPoll()
    }

    const handleVisibilityChange = () => {
      if (cancelled) {
        return
      }
      if (isDocumentVisible()) {
        // Back in the foreground: catch up immediately, then resume the foreground interval.
        clearPending()
        void poll()
      } else {
        // Backgrounded: keep polling, but reschedule at the slower cadence.
        scheduleNextPoll()
      }
    }

    // The view already loads on mount, so the first background poll waits a full interval.
    scheduleNextPoll()

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      cancelled = true
      clearPending()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [enabled, intervalMs, backgroundIntervalMs, qualityActions])

  if (!enabled || latestKeys === null || baselineKeys === null) {
    return 0
  }

  return countNewInboxItems(baselineKeys, latestKeys)
}
