'use client'

import { useMemo, useState } from 'react'

import type { ConversationActivityEntry } from '@/lib/api-types'
import {
  initialActivityTimeline,
  mergeActivity,
  reconcileActivityTimeline,
} from '@/lib/conversation-activity'

/**
 * A conversation's activity timeline from its detail read and the tail's polls, reconciled by
 * `reconcileActivityTimeline` as each read arrives: the detail read is authoritative over what it
 * covers, and a poll adds what it brings. The array keeps its identity while no read changes it, so
 * the thread re-places its events only when there is something new.
 */
export const useConversationActivity = ({
  conversationId,
  detail,
  poll,
}: {
  conversationId: string | null
  detail: readonly ConversationActivityEntry[] | undefined
  poll: readonly ConversationActivityEntry[] | undefined
}): ConversationActivityEntry[] => {
  const reads = { conversationId, detail, poll }
  const [timeline, setTimeline] = useState(() => reconcileActivityTimeline(initialActivityTimeline(conversationId), reads))
  const current = reconcileActivityTimeline(timeline, reads)
  if (current !== timeline) {
    // Adjusting state to new reads during render: React re-renders with it before committing.
    setTimeline(current)
  }
  return useMemo(() => mergeActivity(current.detail, current.tail), [current.detail, current.tail])
}
