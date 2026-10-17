'use client'

import { useEffect, useRef, useState } from 'react'

import { getApiErrorCode } from '@/lib/api-error'
import { hitlApi } from '@/lib/api-hitl'
import type { ChatConversationMessage, ConversationActivityEntry, ConversationOwnership } from '@/lib/api-types'
import { mergeTailMessages } from '@/lib/conversation-tail'

interface UseConversationTailInput {
  conversationId: string
  enabled: boolean
  intervalMs?: number
  initialCursor?: string
  /**
   * Called once when the conversation is gone — deleted, or aged out — while the poll is open.
   * Polling stops; the caller clears the view the same way a failed first read does.
   */
  onNotFound?: () => void
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
   * The activity the latest poll read, oldest first; undefined until a poll has read it. The first
   * poll reads the whole timeline, each later one a recent window, which repeats events already
   * read. `useConversationActivity` folds each read into the timeline with the detail fetch's.
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
  onNotFound,
}: UseConversationTailInput): ConversationTailState => {
  const onNotFoundRef = useRef(onNotFound)
  useEffect(() => {
    onNotFoundRef.current = onNotFound
  }, [onNotFound])
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
        if (tail.activity) {
          setActivity(tail.activity)
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
        if (getApiErrorCode(caught) === 'not_found') {
          onNotFoundRef.current?.()
          return
        }
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
