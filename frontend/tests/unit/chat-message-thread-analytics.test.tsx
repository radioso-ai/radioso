/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('ChatMessageThread analytics controls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    vi.unstubAllGlobals()
    container.remove()
  })

  it('does not emit product analytics when analytics are disabled', async () => {
    await act(async () => {
      root.render(
        <ChatMessageThread
          messages={[
            {
              id: 'assistant-1',
              role: 'assistant',
              content: '[Read more](https://example.com/docs)',
              createdAt: '2026-04-02T10:00:00.000Z',
            },
          ]}
          analyticsEnabled={false}
          onOpenDocument={async () => 'opened'}
        />,
      )
    })

    container.querySelector<HTMLAnchorElement>('a[href^="https://example.com/docs"]')?.click()

    expect(fetch).not.toHaveBeenCalled()
  })
})
