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

/** A teammate's edits to the open conversation, shown over whatever the detail or a read holds. */
interface Overlay {
  conversationId: string
  edits: readonly { name: string; changed: ConversationAttribute | null }[]
}

interface LiveConversationAttributes {
  /** Undefined while the detail is still loading. */
  attributes: ConversationAttribute[] | undefined
  /**
   * Shows a teammate's edit at once, as the edit's response read it. The edit stays over a detail
   * that started loading before it, until a read that started after it returns. With
   * `classificationQueued` the AI is about to fill the attribute again, so it reads on the usual schedule.
   */
  applyChange: (name: string, changed: ConversationAttribute | null, options?: { classificationQueued?: boolean }) => void
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
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const loadedRef = useRef(loaded)
  // Bumped by each edit; a read only counts if no edit landed between its start and its end.
  const edits = useRef(0)
  const afterEditTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const delivered = useRef<{ conversationId: string; lastMessageId: string | undefined } | null>(null)
  const lastMessageId = tail.messages.at(-1)?.id

  useEffect(() => {
    loadedRef.current = loaded
  }, [loaded])

  useEffect(() => () => {
    afterEditTimers.current.forEach(clearTimeout)
    afterEditTimers.current = []
    setOverlay(null)
    setReread(null)
  }, [conversationId])

  // One read of the first page; its attributes already include every edit made before it started.
  const read = useCallback((id: string, isCancelled: () => boolean) => {
    const editsBefore = edits.current
    void chatApi.getHistoryConversation(id, { limit: 1 })
      .then((detail) => {
        if (!isCancelled() && detail.attributes && edits.current === editsBefore) {
          setReread({ conversationId: id, over: loadedRef.current, attributes: detail.attributes })
          setOverlay((current) => (current?.conversationId === id ? null : current))
        }
      })
      .catch(() => {
        // The attributes on screen stay; the next delivery reads again.
      })
  }, [])

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
    const timers = REREAD_DELAYS_MS.map((delay) => setTimeout(() => read(conversationId, () => cancelled), delay))
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [conversationId, lastMessageId, tail.hasPolled, read])

  const applyChange = useCallback((name: string, changed: ConversationAttribute | null, options?: { classificationQueued?: boolean }) => {
    if (!conversationId) return
    edits.current += 1
    setOverlay((current) => ({
      conversationId,
      edits: [...(current?.conversationId === conversationId ? current.edits : []), { name, changed }],
    }))
    if (options?.classificationQueued) {
      afterEditTimers.current.forEach(clearTimeout)
      afterEditTimers.current = REREAD_DELAYS_MS.map((delay) => setTimeout(() => read(conversationId, () => false), delay))
    }
  }, [conversationId, read])

  if (!loaded) return { attributes: undefined, applyChange }
  const base = reread && reread.conversationId === conversationId && reread.over === loaded ? reread.attributes : loaded
  const applied = overlay && overlay.conversationId === conversationId
    ? overlay.edits.reduce<ConversationAttribute[] | undefined>((shown, edit) => applyAttributeChange(shown, edit.name, edit.changed), base)
    : base
  return { attributes: applied, applyChange }
}
