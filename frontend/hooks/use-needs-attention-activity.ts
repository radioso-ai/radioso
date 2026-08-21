'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import {
  HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
  countNewInboxItems,
  inboxItemKeys,
  selectHumanOwnedConversations,
} from '@/lib/needs-attention'
import {
  createEmptyQualityInboxSnapshot,
  loadQualityInboxSourceAttempts,
  qualityInboxPresentation,
  reduceQualityInboxSnapshot,
} from '@/lib/needs-attention-quality'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

const NEEDS_ATTENTION_RECONCILE_INTERVAL_MS = 60_000
const NEEDS_ATTENTION_CHANGE_KINDS = [
  'hitl.decision_created',
  'hitl.decision_resolved',
  'conversation.ownership_changed',
  'quality.feedback_changed',
  'quality.triage_changed',
] as const

interface UseNeedsAttentionActivityInput {
  /** Per-item keys of the inbox state currently shown to the operator (see `inboxItemKeys`). */
  baselineKeys: readonly string[] | null
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
  enabled = true,
  intervalMs = NEEDS_ATTENTION_RECONCILE_INTERVAL_MS,
  backgroundIntervalMs = NEEDS_ATTENTION_RECONCILE_INTERVAL_MS,
}: UseNeedsAttentionActivityInput): number => {
  const baselineSignature = baselineKeys === null ? null : baselineKeys.join('\u0000')
  const [latestState, setLatestState] = useState<{
    baselineSignature: string | null
    keys: string[] | null
  }>({ baselineSignature: null, keys: null })
  const refreshRef = useRef<(() => void) | null>(null)
  const refreshFromHint = useCallback(() => {
    refreshRef.current?.()
  }, [])

  useWorkspaceEventsOptional(enabled ? NEEDS_ATTENTION_CHANGE_KINDS : [], refreshFromHint)

  useEffect(() => {
    if (!enabled) {
      refreshRef.current = null
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let isPolling = false
    let refreshQueued = false
    let latestDecisions: Parameters<typeof inboxItemKeys>[0] = []
    let latestConversations: Parameters<typeof inboxItemKeys>[1] = []
    let latestQualitySnapshot = createEmptyQualityInboxSnapshot()

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
      if (isPolling) {
        refreshQueued = true
        return
      }
      isPolling = true
      const [approvalsResult, conversationsResult, qualityResult] = await Promise.allSettled([
        hitlApi.listPendingDecisions(),
        chatApi.listChatHistory({
          limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
          offset: 0,
          ownership: 'human_owned',
        }),
        loadQualityInboxSourceAttempts({ includeReviewSummary: false }),
      ])
      if (cancelled) {
        isPolling = false
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
        latestQualitySnapshot = reduceQualityInboxSnapshot(
          latestQualitySnapshot,
          qualityResult.value,
        )
        hasFreshSource = true
      }

      if (hasFreshSource) {
        const latestQualityTurns = qualityInboxPresentation(
          latestQualitySnapshot,
        ).turns
        setLatestState({
          baselineSignature,
          keys: inboxItemKeys(latestDecisions, latestConversations, latestQualityTurns),
        })
      }

      isPolling = false
      if (refreshQueued) {
        refreshQueued = false
        void poll()
      } else {
        scheduleNextPoll()
      }
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
    refreshRef.current = () => {
      clearPending()
      void poll()
    }
    scheduleNextPoll()

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      cancelled = true
      refreshRef.current = null
      clearPending()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [baselineSignature, enabled, intervalMs, backgroundIntervalMs])

  if (
    !enabled
    || latestState.keys === null
    || baselineKeys === null
    || latestState.baselineSignature !== baselineSignature
  ) {
    return 0
  }

  return countNewInboxItems(baselineKeys, latestState.keys)
}
