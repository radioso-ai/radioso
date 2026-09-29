'use client'

import { useCallback, useEffect, useState } from 'react'

import { hitlApi } from '@/lib/api-hitl'
import type { ConversationOperator } from '@/lib/api-types'

/**
 * The workspace's teammates who can own a conversation, for the response
 * view's "Hand to…" menu. Read on mount and again on `refresh` — after a
 * transfer finds its target no longer eligible. A failed read leaves the menu
 * out rather than blocking the composer.
 */
export const useConversationOperators = (
  enabled: boolean,
): { operators: ConversationOperator[]; refresh: () => void } => {
  const [operators, setOperators] = useState<ConversationOperator[]>([])
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const controller = new AbortController()

    void hitlApi.listConversationOperators(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setOperators(response.operators)
        }
      })
      .catch(() => {
        // No teammates to offer; replying and taking over still work.
      })

    return () => controller.abort()
  }, [enabled, generation])

  const refresh = useCallback(() => setGeneration((current) => current + 1), [])

  return { operators, refresh }
}
