'use client'

import { useEffect, useState } from 'react'

import { hitlApi } from '@/lib/api-hitl'

/**
 * Count of blocking approvals waiting on an operator. Powers the Activity badge in the
 * rail so operators see at a glance that something needs them, without opening the section.
 *
 * Intentionally scoped to pending approvals (the must-act, conversation-blocking items)
 * via the dedicated decisions endpoint — a nav badge should not issue heavy list queries
 * on every page. Awaiting-human handoffs are tracked inside the Activity inbox itself.
 * Best-effort: a failed poll leaves the previous count in place.
 */
export function useInboxCount({
  enabled = true,
  intervalMs = 30000,
}: { enabled?: boolean; intervalMs?: number } = {}): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const approvals = await hitlApi.listPendingDecisions()
        if (cancelled) {
          return
        }
        setCount(approvals.decisions.length)
      } catch {
        // best-effort badge
      }
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
