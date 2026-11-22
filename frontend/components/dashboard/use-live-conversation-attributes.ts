'use client'

import { useEffect, useRef, useState } from 'react'

import { chatApi } from '@/lib/api'
import type { ChatConversationMessage, ConversationAttribute } from '@/lib/api-types'

/**
 * When to read a conversation's attributes again after the tail delivers a new message. The AI
 * sets them in a background job after a turn commits, seconds after the reply, and no workspace
 * event announces the write; two reads per delivery catch it without polling.
 */
const REREAD_DELAYS_MS = [3_000, 10_000] as const

interface Reread {
  conversationId: string
  /** The loaded attributes this read is newer than; a reloaded detail replaces it. */
  over: readonly ConversationAttribute[] | undefined
  attributes: ConversationAttribute[]
}

/**
 * A conversation's attributes, kept current while it is open: the detail's own, then a first-page
 * read shortly after each message the tail delivers.
 */
export const useLiveConversationAttributes = ({
  conversationId,
  loaded,
  tail,
}: {
  conversationId: string | null
  loaded: ConversationAttribute[] | undefined
  tail: { messages: readonly ChatConversationMessage[]; hasPolled: boolean }
}): ConversationAttribute[] | undefined => {
  const [reread, setReread] = useState<Reread | null>(null)
  const loadedRef = useRef(loaded)
  const delivered = useRef<{ conversationId: string; lastMessageId: string | undefined } | null>(null)
  const lastMessageId = tail.messages.at(-1)?.id

  useEffect(() => {
    loadedRef.current = loaded
  }, [loaded])

  useEffect(() => {
    if (!conversationId || !tail.hasPolled) {
      delivered.current = null
      return
    }
    if (delivered.current?.conversationId !== conversationId) {
      // The first poll repeats the window the detail already loaded.
      delivered.current = { conversationId, lastMessageId }
      return
    }
    if (delivered.current.lastMessageId === lastMessageId) {
      return
    }
    delivered.current = { conversationId, lastMessageId }

    let cancelled = false
    const timers = REREAD_DELAYS_MS.map((delay) => setTimeout(() => {
      void chatApi.getHistoryConversation(conversationId, { limit: 1 })
        .then((detail) => {
          if (!cancelled && detail.attributes) {
            setReread({ conversationId, over: loadedRef.current, attributes: detail.attributes })
          }
        })
        .catch(() => {
          // The attributes on screen stay; the next delivery reads again.
        })
    }, delay))

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [conversationId, lastMessageId, tail.hasPolled])

  return reread && reread.conversationId === conversationId && reread.over === loaded ? reread.attributes : loaded
}
