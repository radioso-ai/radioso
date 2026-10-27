/* @vitest-environment jsdom */

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatScroll, type ChatScrollMessage } from '@/hooks/use-chat-scroll'

// The container sits at the top of the viewport, scrolled 100px down, with the
// visitor's latest message 300px below its top edge.
function mountScrollableThread() {
  const container = document.createElement('div')
  const message = document.createElement('div')
  message.dataset.messageId = 'visitor-2'
  container.appendChild(message)
  document.body.appendChild(container)
  container.scrollTop = 100
  container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  message.getBoundingClientRect = () => ({ top: 300 }) as DOMRect
  const scrollTo = vi.fn()
  container.scrollTo = scrollTo
  return { container, scrollTo }
}

function renderChatScroll({
  container,
  messages,
  topInsetPx,
}: {
  container: HTMLElement
  messages: ChatScrollMessage[]
  topInsetPx?: number
}) {
  let inset = topInsetPx
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const containerRef = { current: container }
  const sentinelRef = createRef<HTMLElement>()
  let latest: ReturnType<typeof useChatScroll> | null = null

  function Harness({ thread }: { thread: ChatScrollMessage[] }) {
    latest = useChatScroll({ messages: thread, containerRef, sentinelRef, topInsetPx: inset })
    return null
  }

  act(() => {
    root.render(<Harness thread={messages} />)
  })

  return {
    get scroll() {
      if (!latest) throw new Error('hook did not render')
      return latest
    },
    rerender(thread: ChatScrollMessage[], nextInset = inset) {
      inset = nextInset
      act(() => {
        root.render(<Harness thread={thread} />)
      })
    },
  }
}

const turn: ChatScrollMessage[] = [
  { id: 'visitor-1', role: 'user' },
  { id: 'agent-1', role: 'assistant', status: 'complete' },
  { id: 'visitor-2', role: 'user' },
]

describe('useChatScroll', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it("pins the visitor's latest message to the top edge of the thread", () => {
    const { container, scrollTo } = mountScrollableThread()
    const { scroll } = renderChatScroll({ container, messages: turn })

    act(() => scroll.scrollToLatestTurn('auto'))

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: 'auto' })
  })

  it('pins below a header that overlays the top of the thread', () => {
    const { container, scrollTo } = mountScrollableThread()
    const { scroll } = renderChatScroll({ container, messages: turn, topInsetPx: 61 })

    act(() => scroll.scrollToLatestTurn('auto'))

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 339, behavior: 'auto' })
  })

  it('pins below a header measured after the pin was scheduled', () => {
    const { container, scrollTo } = mountScrollableThread()
    const thread = renderChatScroll({ container, messages: turn.slice(0, 2), topInsetPx: 0 })
    const frames: FrameRequestCallback[] = []
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })

    thread.rerender(turn, 0)
    thread.rerender(turn, 61)
    act(() => frames.forEach((frame) => frame(0)))

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 339, behavior: 'smooth' })
  })

  it('keeps pulling the message up to just below the overlay while the reply streams', () => {
    const { container, scrollTo } = mountScrollableThread()
    const thread = renderChatScroll({ container, messages: turn, topInsetPx: 61 })
    scrollTo.mockClear()

    thread.rerender([...turn, { id: 'agent-2', role: 'assistant', status: 'streaming' }])

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 339, behavior: 'auto' })
  })
})
