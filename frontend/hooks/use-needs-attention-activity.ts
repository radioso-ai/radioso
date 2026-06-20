'use client'

import { useEffect, useState } from 'react'

import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import {
  HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
  inboxSignature,
  selectHumanOwnedConversations,
} from '@/lib/needs-attention'

interface UseNeedsAttentionActivityInput {
  /** Fingerprint of the inbox state currently shown to the operator (see `inboxSignature`). */
  baselineSignature: string | null
  enabled?: boolean
  intervalMs?: number
}

/**
 * Quietly polls the inbox endpoints in the background and reports whether the latest snapshot
 * differs from what the operator is currently looking at. It never replaces the displayed list —
 * the view surfaces a manual refresh affordance when this returns `true`, so the operator is never
 * interrupted mid-read. When the view refreshes, `baselineSignature` updates and the flag clears.
 *
 * Polling only runs while the document is visible: a backgrounded browser tab stops fetching, and
 * returning to the foreground polls immediately (then resumes the interval) so a stale tab catches
 * up the moment the operator looks at it again.
 */
export const useNeedsAttentionActivity = ({
  baselineSignature,
  enabled = true,
  intervalMs = 15000,
}: UseNeedsAttentionActivityInput): boolean => {
  const [latestSignature, setLatestSignature] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const isDocumentVisible = () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden'

    const clearPending = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
    }

    const scheduleNextPoll = () => {
      clearPending()
      // Don't keep a timer alive while backgrounded; visibilitychange restarts polling.
      if (cancelled || !isDocumentVisible()) {
        return
      }
      timeoutId = setTimeout(poll, intervalMs)
    }

    const poll = async () => {
      try {
        const [approvalsResult, conversationsResult] = await Promise.all([
          hitlApi.listPendingDecisions(),
          chatApi.listChatHistory({ limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE, offset: 0 }),
        ])
        if (cancelled) {
          return
        }

        setLatestSignature(
          inboxSignature(
            approvalsResult.decisions,
            selectHumanOwnedConversations(conversationsResult.conversations),
          ),
        )
      } catch {
        // The indicator is best-effort; a failed poll just leaves the previous signature in place.
      }

      scheduleNextPoll()
    }

    const handleVisibilityChange = () => {
      if (cancelled) {
        return
      }
      if (isDocumentVisible()) {
        // Back in the foreground: catch up immediately, then resume the interval.
        clearPending()
        void poll()
      } else {
        clearPending()
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
  }, [enabled, intervalMs])

  if (!enabled || latestSignature === null || baselineSignature === null) {
    return false
  }

  return latestSignature !== baselineSignature
}
