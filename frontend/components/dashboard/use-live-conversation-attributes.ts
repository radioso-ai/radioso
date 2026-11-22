'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { chatApi } from '@/lib/api'
import type { ChatConversationMessage, ConversationAttribute } from '@/lib/api-types'
import { applyAttributeChange } from '@/lib/conversation-attribute-edits'

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

interface LiveConversationAttributes {
  attributes: ConversationAttribute[] | undefined
  /** Shows a teammate's edit at once, as the edit's response read it, over any read already under way. */
  applyChange: (name: string, changed: ConversationAttribute | null) => void
}

/**
 * A conversation's attributes, kept current while it is open: the detail's own, then a first-page
 * read shortly after each message the tail delivers, and a teammate's own edits as they land.
 */
export const useLiveConversationAttributes = ({
  conversationId,
  loaded,
  tail,
}: {
  conversationId: string | null
  loaded: ConversationAttribute[] | undefined
  tail: { messages: readonly ChatConversationMessage[]; hasPolled: boolean }
}): LiveConversationAttributes => {
  const [reread, setReread] = useState<Reread | null>(null)
  const loadedRef = useRef(loaded)
  // Bumped by each edit, so a read that started before it can't put the older value back.
  const edits = useRef(0)
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
      const editsBefore = edits.current
      void chatApi.getHistoryConversation(conversationId, { limit: 1 })
        .then((detail) => {
          if (!cancelled && detail.attributes && edits.current === editsBefore) {
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

  const applyChange = useCallback((name: string, changed: ConversationAttribute | null) => {
    if (!conversationId) return
    edits.current += 1
    setReread((current) => {
      const over = loadedRef.current
      const showing = current && current.conversationId === conversationId && current.over === over ? current.attributes : over
      return { conversationId, over, attributes: applyAttributeChange(showing, name, changed) }
    })
  }, [conversationId])

  const attributes = reread && reread.conversationId === conversationId && reread.over === loaded ? reread.attributes : loaded
  return { attributes, applyChange }
}
