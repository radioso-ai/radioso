/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('AssistantMessageContent link analytics', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('reports citation marker, source URL, and assistant markdown link clicks', async () => {
    const onOpenDocument = vi.fn().mockResolvedValue('opened')
    const onLinkClickAnalytics = vi.fn()

    await act(async () => {
      root.render(
        <AssistantMessageContent
          content="Read the [overview](https://example.com/guide?token=secret#intro)."
          citations={[
            {
              documentId: 'document-1',
              chunkId: 'chunk-1',
              title: 'Source 1',
              sourceUrl: 'https://docs.example.com/private/path?token=secret#section',
            },
          ]}
          answerSegments={[
            {
              text: 'Read the [overview](https://example.com/guide?token=secret#intro).',
              citationIndices: [0],
            },
          ]}
          onOpenDocument={onOpenDocument}
          onLinkClickAnalytics={onLinkClickAnalytics}
        />,
      )
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-citation-index="1"]')?.click()
    })

    expect(container.querySelector<HTMLAnchorElement>('a[aria-label="Open Source 1 in a new tab"]')).toBeNull()

    const sourcesToggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Sources'))
    await act(async () => {
      sourcesToggle?.click()
    })

    container.querySelector<HTMLAnchorElement>('a[aria-label="Open Source 1 in a new tab"]')?.click()
    container.querySelector<HTMLAnchorElement>('a[href="https://example.com/guide?token=secret#intro"]')?.click()

    expect(onOpenDocument).toHaveBeenCalledWith('document-1')
    expect(onLinkClickAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      linkType: 'citation_marker',
      citationIndex: 0,
      documentId: 'document-1',
      chunkId: 'chunk-1',
    }))
    expect(onLinkClickAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      linkType: 'citation_source_url',
      citationIndex: 0,
      documentId: 'document-1',
      chunkId: 'chunk-1',
      destinationUrl: 'https://docs.example.com/private/path?token=secret#section',
    }))
    expect(onLinkClickAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      linkType: 'assistant_url',
      destinationUrl: 'https://example.com/guide?token=secret#intro',
    }))
  })
})
