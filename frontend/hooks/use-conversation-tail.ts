'use client'

import { useEffect, useState } from 'react'

import { hitlApi } from '@/lib/api-hitl'
import type { ChatConversationMessage, ConversationOwnership } from '@/lib/api-types'
import { mergeTailMessages } from '@/lib/conversation-tail'

interface UseConversationTailInput {
  conversationId: string
  enabled: boolean
  intervalMs?: number
  initialCursor?: string
}

interface ConversationTailState {
  messages: ChatConversationMessage[]
  ownership: ConversationOwnership | undefined
  cursor: string | null
  error: unknown
  isPolling: boolean
}

export const useConversationTail = ({
  conversationId,
  enabled,
  intervalMs = 4000,
  initialCursor,
}: UseConversationTailInput): ConversationTailState => {
  const [messages, setMessages] = useState<ChatConversationMessage[]>([])
  const [ownership, setOwnership] = useState<ConversationOwnership | undefined>()
  const [cursor, setCursor] = useState<string | null>(initialCursor ?? null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let currentCursor: string | undefined = initialCursor

    queueMicrotask(() => {
      if (cancelled) {
        return
      }

      setMessages([])
      setOwnership(undefined)
      setCursor(initialCursor ?? null)
      setError(null)
    })

    if (!enabled) {
      return () => {
        cancelled = true
      }
    }

    const scheduleNextPoll = () => {
      timeoutId = setTimeout(poll, intervalMs)
    }

    const poll = async () => {
      try {
        const tail = await hitlApi.tailConversation(conversationId, { cursor: currentCursor })
        if (cancelled) {
          return
        }

        setMessages((existing) => mergeTailMessages(existing, tail.messages))
        setOwnership(tail.ownership)
        setCursor(tail.cursor)
        setError(null)
        currentCursor = tail.cursor ?? undefined
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

  return { messages: enabled ? messages : [], ownership: enabled ? ownership : undefined, cursor, error, isPolling: enabled }
}
