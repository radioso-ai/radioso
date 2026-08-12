'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Minimal message shape this scroll manager reads. Any chat message with an id,
 * a role, and an optional streaming status satisfies it, so the hook is not
 * coupled to one surface's message schema (customer thread, Ray copilot, etc.).
 */
export interface ChatScrollMessage {
  id: string
  role: string
  status?: string
}

const NEAR_BOTTOM_THRESHOLD_PX = 96
const PROGRAMMATIC_SCROLL_GUARD_MS_AUTO = 120
const PROGRAMMATIC_SCROLL_GUARD_MS_SMOOTH = 700

function findScrollContainer(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null
  while (el) {
    const overflowY = window.getComputedStyle(el).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return el
    }
    el = el.parentElement
  }
  return null
}

function escapeSelector(value: string) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * Manages chat scroll behavior:
 *  - Pins newly-sent user messages near the top of the viewport so the
 *    assistant reply streams in below them.
 *  - While streaming, keeps nudging the last user message toward the top as
 *    content grows, until it lands at the top (or the user scrolls manually).
 *  - Reports whether the messages container is near the bottom so the host
 *    can show a "jump to latest" affordance.
 */
export function useChatScroll({
  messages,
  containerRef,
  sentinelRef,
  pinUserMessage = true,
}: {
  messages: ChatScrollMessage[]
  containerRef?: RefObject<HTMLElement | null>
  sentinelRef: RefObject<HTMLElement | null>
  pinUserMessage?: boolean
}) {
  const [isAtBottom, setIsAtBottom] = useState(true)
  const resolvedContainerRef = useRef<HTMLElement | null>(null)
  const lastUserMessageIdRef = useRef<string | null>(null)
  const hasInitialisedRef = useRef(false)
  // True after the user manually scrolls during the current turn; cleared when
  // a new user message arrives or when the scroll-to-latest button is pressed.
  const userScrolledThisTurnRef = useRef(false)
  // Timestamp until which scroll events should be treated as the result of our
  // own programmatic scroll, not a user gesture.
  const programmaticScrollUntilRef = useRef(0)

  const resolveContainer = useCallback(() => {
    if (containerRef?.current) {
      resolvedContainerRef.current = containerRef.current
      return containerRef.current
    }
    if (!resolvedContainerRef.current) {
      resolvedContainerRef.current = findScrollContainer(sentinelRef.current)
    }
    return resolvedContainerRef.current
  }, [containerRef, sentinelRef])

  const markProgrammaticScroll = useCallback((behavior: ScrollBehavior) => {
    const guard =
      behavior === 'smooth' ? PROGRAMMATIC_SCROLL_GUARD_MS_SMOOTH : PROGRAMMATIC_SCROLL_GUARD_MS_AUTO
    programmaticScrollUntilRef.current = Date.now() + guard
  }, [])

  const scrollContainerTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const container = resolveContainer()
      if (!container) {
        return
      }
      markProgrammaticScroll(behavior)
      container.scrollTo({ top, behavior })
    },
    [markProgrammaticScroll, resolveContainer],
  )

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const container = resolveContainer()
      if (container) {
        scrollContainerTo(container.scrollHeight, behavior)
        return
      }
      markProgrammaticScroll(behavior)
      sentinelRef.current?.scrollIntoView({ behavior, block: 'end' })
    },
    [markProgrammaticScroll, resolveContainer, scrollContainerTo, sentinelRef],
  )

  const findLastUserMessageId = useCallback(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        return messages[i].id
      }
    }
    return null
  }, [messages])

  const scrollLastUserMessageToTop = useCallback(
    (behavior: ScrollBehavior) => {
      const container = resolveContainer()
      const lastUserId = findLastUserMessageId()
      if (!lastUserId) {
        scrollToBottom(behavior)
        return
      }
      const selector = `[data-message-id="${escapeSelector(lastUserId)}"]`
      const node =
        container?.querySelector<HTMLElement>(selector) ??
        document.querySelector<HTMLElement>(selector)
      if (!container || !node) {
        scrollToBottom(behavior)
        return
      }
      const containerRect = container.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      const target = container.scrollTop + (nodeRect.top - containerRect.top)
      scrollContainerTo(Math.max(0, target), behavior)
    },
    [findLastUserMessageId, resolveContainer, scrollContainerTo, scrollToBottom],
  )

  /**
   * Scrolls the latest user message to the top of the viewport. Re-enables the
   * progressive pin for the rest of this turn.
   */
  const scrollToLatestTurn = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      userScrolledThisTurnRef.current = false
      scrollLastUserMessageToTop(behavior)
    },
    [scrollLastUserMessageToTop],
  )

  useEffect(() => {
    const updateIsAtBottom = (target: HTMLElement) => {
      const distance = target.scrollHeight - target.scrollTop - target.clientHeight
      setIsAtBottom(distance <= NEAR_BOTTOM_THRESHOLD_PX)
    }

    const container = resolveContainer()
    if (!container) {
      return
    }

    const handleScroll = () => {
      if (Date.now() > programmaticScrollUntilRef.current) {
        userScrolledThisTurnRef.current = true
      }
      updateIsAtBottom(container)
    }
    updateIsAtBottom(container)
    container.addEventListener('scroll', handleScroll, { passive: true })

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateIsAtBottom(container)) : null
    resizeObserver?.observe(container)
    const inner = container.firstElementChild
    if (inner instanceof HTMLElement) {
      resizeObserver?.observe(inner)
    }

    return () => {
      container.removeEventListener('scroll', handleScroll)
      resizeObserver?.disconnect()
    }
  }, [resolveContainer, messages.length])

  // Track new user messages: reset the per-turn user-scroll flag and do the
  // initial smooth pin.
  useEffect(() => {
    const lastUserId = findLastUserMessageId()

    if (!hasInitialisedRef.current) {
      hasInitialisedRef.current = true
      lastUserMessageIdRef.current = lastUserId
      if (messages.length > 0) {
        window.requestAnimationFrame(() => scrollToBottom('auto'))
      }
      return
    }

    if (!lastUserId || lastUserId === lastUserMessageIdRef.current) {
      return
    }

    lastUserMessageIdRef.current = lastUserId
    userScrolledThisTurnRef.current = false

    if (!pinUserMessage) {
      return
    }

    window.requestAnimationFrame(() => scrollLastUserMessageToTop('smooth'))
  }, [findLastUserMessageId, messages.length, pinUserMessage, scrollLastUserMessageToTop, scrollToBottom])

  // Progressive pin during streaming: as the assistant reply grows, nudge the
  // last user message toward the top until it lands there. Stop if the user
  // has scrolled manually this turn.
  const isStreaming = messages.some(
    (message) => message.role === 'assistant' && message.status === 'streaming',
  )

  useEffect(() => {
    if (!pinUserMessage || !isStreaming || userScrolledThisTurnRef.current) {
      return
    }

    const container = resolveContainer()
    const lastUserId = findLastUserMessageId()
    if (!container || !lastUserId) {
      return
    }
    const selector = `[data-message-id="${escapeSelector(lastUserId)}"]`
    const node =
      container.querySelector<HTMLElement>(selector) ??
      document.querySelector<HTMLElement>(selector)
    if (!node) {
      return
    }

    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    const offsetFromTop = nodeRect.top - containerRect.top

    // Only pull the message UP toward the top. If it's already at or above the
    // top edge, leave the user where they are.
    if (offsetFromTop > 2) {
      const target = container.scrollTop + offsetFromTop
      scrollContainerTo(Math.max(0, target), 'auto')
    }
  }, [findLastUserMessageId, isStreaming, messages, pinUserMessage, resolveContainer, scrollContainerTo])

  return { isAtBottom, scrollToBottom, scrollToLatestTurn }
}
