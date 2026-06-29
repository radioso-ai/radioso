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

  it('reveals, expands, and highlights the matching source when a link-only citation is clicked', async () => {
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    const onLinkClickAnalytics = vi.fn()

    try {
      await act(async () => {
        root.render(
          <AssistantMessageContent
            content="Grounded answer."
            citations={[
              { documentId: 'document-1', chunkId: 'chunk-1', title: 'First Source' },
              { documentId: 'document-2', chunkId: 'chunk-2', title: 'Second Source' },
            ]}
            answerSegments={[{ text: 'Grounded answer.', citationIndices: [1] }]}
            documentInteractivity="link-only"
            onOpenDocument={vi.fn().mockResolvedValue('unavailable')}
            onLinkClickAnalytics={onLinkClickAnalytics}
          />,
        )
      })

      // Sources panel is collapsed until the marker is clicked.
      expect(container.querySelector('[data-source-index="2"]')).toBeNull()

      const marker = container.querySelector<HTMLButtonElement>('[data-citation-index="2"]')
      expect(marker?.tagName).toBe('BUTTON')

      await act(async () => {
        marker?.click()
      })

      const sourcesToggle = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Sources'))
      expect(sourcesToggle?.getAttribute('aria-expanded')).toBe('true')

      const revealedChip = container.querySelector<HTMLElement>('[data-source-index="2"]')
      expect(revealedChip).not.toBeNull()
      expect(revealedChip?.className).toContain('ring-primary')
      expect(scrollIntoView).toHaveBeenCalled()
      expect(onLinkClickAnalytics).toHaveBeenCalledWith(expect.objectContaining({
        linkType: 'citation_marker',
        citationIndex: 1,
        documentId: 'document-2',
        chunkId: 'chunk-2',
      }))
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('renders unsafe citation source URLs as non-clickable text', async () => {
    await act(async () => {
      root.render(
        <AssistantMessageContent
          content="Sources are available."
          citations={[
            {
              documentId: 'document-safe',
              chunkId: 'chunk-safe',
              title: 'Safe Source',
              sourceUrl: 'https://docs.example.com/safe',
            },
            {
              documentId: 'document-unsafe',
              chunkId: 'chunk-unsafe',
              title: 'Unsafe Source',
              sourceUrl: 'javascript:alert(1)',
            },
            {
              documentId: 'document-data',
              chunkId: 'chunk-data',
              title: 'Data Source',
              sourceUrl: 'data:text/html,<script>alert(1)</script>',
            },
          ]}
          answerSegments={[
            {
              text: 'Sources are available.',
              citationIndices: [0, 1, 2],
            },
          ]}
          onOpenDocument={vi.fn().mockResolvedValue('opened')}
        />,
      )
    })

    const sourcesToggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Sources'))
    await act(async () => {
      sourcesToggle?.click()
    })

    expect(container.querySelector<HTMLAnchorElement>('a[href="https://docs.example.com/safe"]')).not.toBeNull()
    expect(container.querySelector<HTMLAnchorElement>('a[href^="javascript:"]')).toBeNull()
    expect(container.querySelector<HTMLAnchorElement>('a[href^="data:"]')).toBeNull()
    expect(container.textContent).toContain('javascript:alert(1)')
    expect(container.textContent).toContain('data:text/html,<script>alert(1)</script>')
  })
})
