import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'

describe('AssistantMessageContent', () => {
  it('keeps citation markers attached to markdown-rendered segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'This is **important** evidence.',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('[1]')
  })

  it('keeps bare urls clickable inside cited inline segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'See https://example.com for context.',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('href="https://example.com"')
  })

  it('does not turn citation-separated sentences into line breaks', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
          {
            documentId: 'doc-2',
            chunkId: 'chunk-2',
            title: 'Source 2',
          },
        ]}
        answerSegments={[
          {
            text: 'First sentence',
            citationIndices: [0],
          },
          {
            text: '.\nSecond sentence',
            citationIndices: [1],
          },
          {
            text: '.',
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toContain('<br/>')
    expect(html).toContain('First sentence')
    expect(html).toContain('Second sentence')
  })

  it('preserves paragraph markdown inside cited block segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'First paragraph.\n\nSecond paragraph with a [link](https://example.com).',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('<p')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('Second paragraph')
  })

  it('preserves ordered lists when citations are attached per item', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
          {
            documentId: 'doc-2',
            chunkId: 'chunk-2',
            title: 'Source 2',
          },
        ]}
        answerSegments={[
          {
            text: '1. **Start small.** Begin with five minutes.',
            citationIndices: [0],
          },
          {
            text: '2. **Stay consistent.** Pick the same time each day.',
            citationIndices: [1],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('<ol')
    expect(html).toContain('<li')
  })
})
