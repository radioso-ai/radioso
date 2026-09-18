'use client'

import { useEffect, useState } from 'react'

import { chatApi } from '@/lib/api'
import type { ChatConversationSummary } from '@/lib/api-types'

interface UseVisitorConversationsInput {
  /** Null when the conversation has no visitor — the hook then reports an empty, settled state. */
  visitorId: string | null
  excludeConversationId: string
  limit?: number
}

interface VisitorConversationsState {
  conversations: ChatConversationSummary[]
  isLoading: boolean
  error: unknown
}

/** The visitor's other conversations for the drawer's "Previous conversations" panel (spec 1277, FR-041/FR-042). */
export function useVisitorConversations({
  visitorId,
  excludeConversationId,
  limit = 5,
}: UseVisitorConversationsInput): VisitorConversationsState {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false

    // Deferred, like useConversationTail: setState synchronously inside an effect body
    // triggers a cascading-render lint error, so the reset/fetch-start writes queue as a
    // microtask instead of running inline.
    queueMicrotask(() => {
      if (cancelled) {
        return
      }

      if (!visitorId) {
        setConversations([])
        setIsLoading(false)
        setError(null)
        return
      }

      setIsLoading(true)
      setError(null)

      chatApi.listVisitorConversations(visitorId, { limit, exclude: excludeConversationId })
        .then((page) => {
          if (cancelled) {
            return
          }
          setConversations(page.conversations)
          setIsLoading(false)
        })
        .catch((caught: unknown) => {
          if (cancelled) {
            return
          }
          setError(caught)
          setIsLoading(false)
        })
    })

    return () => {
      cancelled = true
    }
  }, [visitorId, excludeConversationId, limit])

  return { conversations, isLoading, error }
}
