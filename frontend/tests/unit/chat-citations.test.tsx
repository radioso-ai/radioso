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

    expect(html).toMatch(/<strong[^>]*>important<\/strong>/)
    expect(html).toMatch(/<strong[^>]*>important<\/strong> evidence\.<button/)
    expect(html).toContain('[1]')
    expect(html).toContain('aria-label="Open source 1: Source 1"')
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
    expect(html).toMatch(/https:\/\/example\.com<\/a> for context\.<button/)
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
    expect(html).toMatch(/First sentence<button/)
    expect(html).toMatch(/Second sentence<button/)
  })
})
