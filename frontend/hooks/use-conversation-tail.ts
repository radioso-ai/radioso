'use client'

import { useEffect, useState } from 'react'

import { hitlApi } from '@/lib/api-hitl'
import type { ChatConversationMessage, ConversationActivityEntry, ConversationOwnership } from '@/lib/api-types'
import { mergeActivity } from '@/lib/conversation-activity'
import { mergeTailMessages } from '@/lib/conversation-tail'

interface UseConversationTailInput {
  conversationId: string
  enabled: boolean
  intervalMs?: number
  initialCursor?: string
}

interface ConversationTailState {
  messages: ChatConversationMessage[]
  /**
   * The conversation's ownership record as of the latest poll, passed through
   * as the tail reports it: present whenever the conversation has a record,
   * whatever its state — including AI-owned after a hand-back — and absent
   * only when it never had one. The Inbox pane weighs it against the detail
   * fetch's record by `version` (`freshestOwnership`) rather than trusting
   * either read alone.
   */
  ownership: ConversationOwnership | undefined
  /**
   * The conversation's activity timeline as of the latest poll, oldest first; undefined until a poll
   * has read it. The first poll reads the whole timeline, each later one only what was recorded
   * since, merged in. Merged with the detail fetch's by `mergeActivity`.
   */
  activity: ConversationActivityEntry[] | undefined
  cursor: string | null
  error: unknown
  isPolling: boolean
  hasPolled: boolean
}

export const useConversationTail = ({
  conversationId,
  enabled,
  intervalMs = 4000,
  initialCursor,
}: UseConversationTailInput): ConversationTailState => {
  const [messages, setMessages] = useState<ChatConversationMessage[]>([])
  const [ownership, setOwnership] = useState<ConversationOwnership | undefined>()
  const [activity, setActivity] = useState<ConversationActivityEntry[] | undefined>()
  const [cursor, setCursor] = useState<string | null>(initialCursor ?? null)
  const [error, setError] = useState<unknown>(null)
  const [hasPolled, setHasPolled] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let currentCursor: string | undefined = initialCursor
    let currentActivityCursor: string | undefined

    queueMicrotask(() => {
      if (cancelled) {
        return
      }

      setMessages([])
      setOwnership(undefined)
      setActivity(undefined)
      setCursor(initialCursor ?? null)
      setError(null)
      setHasPolled(false)
    })

    if (!enabled) {
      return () => {
        cancelled = true
      }
    }

    const scheduleNextPoll = () => {
      timeoutId = setTimeout(() => {
        void poll()
      }, intervalMs)
    }

    const poll = async () => {
      try {
        const tail = await hitlApi.tailConversation(conversationId, {
          cursor: currentCursor,
          activityCursor: currentActivityCursor,
        })
        if (cancelled) {
          return
        }

        setMessages((existing) => mergeTailMessages(existing, tail.messages))
        setOwnership(tail.ownership)
        const newActivity = tail.activity
        if (newActivity) {
          setActivity((existing) => mergeActivity(existing, newActivity))
        }
        setCursor(tail.cursor)
        setError(null)
        setHasPolled(true)
        currentCursor = tail.cursor ?? undefined
        currentActivityCursor = tail.activityCursor ?? undefined
      } catch (caught) {
        if (cancelled) {
          return
        }

        setError(caught)
      }

      if (!cancelled) {
        scheduleNextPoll()
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [conversationId, enabled, initialCursor, intervalMs])

  return {
    messages: enabled ? messages : [],
    ownership: enabled ? ownership : undefined,
    activity: enabled ? activity : undefined,
    cursor,
    error,
    isPolling: enabled,
    hasPolled: enabled ? hasPolled : false,
  }
}
