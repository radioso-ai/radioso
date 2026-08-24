'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

const INBOX_RECONCILE_INTERVAL_MS = 60_000
const INBOX_CHANGE_KINDS = [
  'hitl.decision_created',
  'hitl.decision_resolved',
  'conversation.ownership_changed',
] as const

/**
 * Count of blocking approvals and human-owned conversations waiting on an operator. Powers the
 * Activity badge in the rail so operators see at a glance that something needs them.
 *
 * The conversation request reads only its total with a one-row page. Each source retains its
 * prior value independently when it fails, so a transient failure never hides the other source.
 */
export function useInboxCount({
  enabled = true,
  intervalMs = INBOX_RECONCILE_INTERVAL_MS,
}: { enabled?: boolean; intervalMs?: number } = {}): number {
  const [count, setCount] = useState(0)
  const approvalCountRef = useRef(0)
  const humanOwnedCountRef = useRef(0)
  const refreshRef = useRef<(() => void) | null>(null)
  const refreshFromHint = useCallback(() => {
    refreshRef.current?.()
  }, [])

  useWorkspaceEventsOptional(enabled ? INBOX_CHANGE_KINDS : [], refreshFromHint)

  useEffect(() => {
    if (!enabled) {
      refreshRef.current = null
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let isPolling = false
    let refreshQueued = false

    const scheduleNextPoll = () => {
      if (!cancelled) {
        timeoutId = setTimeout(poll, intervalMs)
      }
    }

    const poll = async () => {
      if (isPolling) {
        refreshQueued = true
        return
      }
      isPolling = true
      const [approvalsResult, conversationsResult] = await Promise.allSettled([
        hitlApi.listPendingDecisions(),
        chatApi.listChatHistory({ limit: 1, ownership: 'human_owned' }),
      ])
      if (cancelled) {
        isPolling = false
        return
      }
      if (approvalsResult.status === 'fulfilled') {
        approvalCountRef.current = approvalsResult.value.decisions.length
      }
      if (conversationsResult.status === 'fulfilled') {
        humanOwnedCountRef.current = conversationsResult.value.total
      }
      setCount(approvalCountRef.current + humanOwnedCountRef.current)
      isPolling = false
      if (refreshQueued) {
        refreshQueued = false
        void poll()
      } else {
        scheduleNextPoll()
      }
    }

    refreshRef.current = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      void poll()
    }
    void poll()

    return () => {
      cancelled = true
      refreshRef.current = null
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [enabled, intervalMs])

  return enabled ? count : 0
}
