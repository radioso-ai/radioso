'use client'

import { useEffect, useRef } from 'react'

import { playInboxChime } from '@/lib/inbox-chime'

/** Prefixes the tab title with the open count, or restores the bare title at zero. */
export const formatInboxTabTitle = (baseTitle: string, openCount: number): string =>
  openCount > 0 ? `(${openCount}) ${baseTitle}` : baseTitle

/**
 * True only when the open count grew relative to a known previous count. A
 * `null` previous count (nothing observed yet, e.g. the first render) never
 * counts as an increase — the chime is for arrivals while the tab is open, not
 * for whatever the inbox already contained on load.
 */
export const didInboxOpenCountIncrease = (previousCount: number | null, nextCount: number): boolean =>
  previousCount !== null && nextCount > previousCount

/**
 * While the dashboard tab is open: prefixes `document.title` with the total
 * open inbox count, and plays a soft chime when the count of CRITICAL open
 * items (handoffs + approvals) increases — a new handoff or approval arrived
 * via the existing invalidation/polling refetch (this hook does not fetch
 * anything itself). Written negative feedback moves the title count but never
 * triggers the chime; that split is a deliberate product decision, not an
 * oversight. Restores the original title on unmount.
 */
export const useInboxAttentionSignal = (openCount: number, criticalOpenCount: number): void => {
  const baseTitleRef = useRef<string | null>(null)
  const previousCriticalCountRef = useRef<number | null>(null)

  useEffect(() => {
    if (baseTitleRef.current === null) {
      baseTitleRef.current = document.title
    }
    document.title = formatInboxTabTitle(baseTitleRef.current, openCount)
  }, [openCount])

  useEffect(() => {
    if (didInboxOpenCountIncrease(previousCriticalCountRef.current, criticalOpenCount)) {
      playInboxChime()
    }
    previousCriticalCountRef.current = criticalOpenCount
  }, [criticalOpenCount])

  useEffect(() => () => {
    if (baseTitleRef.current !== null) {
      document.title = baseTitleRef.current
    }
  }, [])
}
