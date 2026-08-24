'use client'

import { useCallback, useEffect, useRef } from 'react'

import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

interface UseBackgroundRefreshOptions {
  /** Workspace push change kinds that make this surface stale. */
  changeKinds: readonly string[]
  /**
   * Refetch the surface without disturbing what the operator is reading: no
   * spinner, no error banner, and the previous data stays on screen if it fails.
   */
  onRefresh: () => void
  /**
   * Reconcile floor, in milliseconds, for staleness the subscribed kinds do not
   * cover. Omit to rely on push alone.
   */
  intervalMs?: number
  /**
   * While true, invalidations are held and replayed once as soon as it clears.
   * Swapping rows under an open popover or an in-flight mutation would strand
   * the operator mid-action, so the refresh waits for them instead.
   */
  suspended?: boolean
}

/**
 * Keeps an operator surface current from the workspace push channel.
 *
 * The channel only carries invalidation hints, so every consumer refetches its
 * own data. This hook owns the part they all share: subscribe, hold the refresh
 * while the operator is mid-action, and fall back to a reconcile floor.
 */
export function useBackgroundRefresh({
  changeKinds,
  onRefresh,
  intervalMs,
  suspended = false,
}: UseBackgroundRefreshOptions): void {
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  const suspendedRef = useRef(suspended)
  const deferredRef = useRef(false)

  const requestRefresh = useCallback(() => {
    if (suspendedRef.current) {
      deferredRef.current = true
      return
    }
    onRefreshRef.current()
  }, [])

  useWorkspaceEventsOptional(changeKinds, requestRefresh)

  useEffect(() => {
    suspendedRef.current = suspended
    if (suspended || !deferredRef.current) {
      return
    }
    // Collapse everything that arrived while suspended into one refetch.
    deferredRef.current = false
    onRefreshRef.current()
  }, [suspended])

  useEffect(() => {
    if (!intervalMs) {
      return
    }
    const intervalId = window.setInterval(requestRefresh, intervalMs)
    return () => window.clearInterval(intervalId)
  }, [intervalMs, requestRefresh])
}
