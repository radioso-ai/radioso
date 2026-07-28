'use client'

import { useEffect, useRef, useState } from 'react'

import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'

/**
 * Count of blocking approvals and human-owned conversations waiting on an operator. Powers the
 * Activity badge in the rail so operators see at a glance that something needs them.
 *
 * The conversation request reads only its total with a one-row page. Each source retains its
 * prior value independently when it fails, so a transient failure never hides the other source.
 */
export function useInboxCount({
  enabled = true,
  intervalMs = 30000,
}: { enabled?: boolean; intervalMs?: number } = {}): number {
  const [count, setCount] = useState(0)
  const approvalCountRef = useRef(0)
  const humanOwnedCountRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      const [approvalsResult, conversationsResult] = await Promise.allSettled([
        hitlApi.listPendingDecisions(),
        chatApi.listChatHistory({ limit: 1, ownership: 'human_owned' }),
      ])
      if (cancelled) {
        return
      }
      if (approvalsResult.status === 'fulfilled') {
        approvalCountRef.current = approvalsResult.value.decisions.length
      }
      if (conversationsResult.status === 'fulfilled') {
        humanOwnedCountRef.current = conversationsResult.value.total
      }
      setCount(approvalCountRef.current + humanOwnedCountRef.current)
      if (!cancelled) {
        timeoutId = setTimeout(poll, intervalMs)
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [enabled, intervalMs])

  return enabled ? count : 0
}
