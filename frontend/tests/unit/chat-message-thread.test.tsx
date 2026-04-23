import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'

describe('ChatMessageThread', () => {
  it('does not render assistant message selection as a nested button when citations are present', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'unused',
            createdAt: '2026-04-02T10:00:00.000Z',
            citations: [
              {
                documentId: 'doc-1',
                chunkId: 'chunk-1',
                title: 'Source 1',
              },
            ],
            answerSegments: [
              {
                text: 'Answer text',
                citationIndices: [0],
              },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
        onMessageSelect={() => {}}
        selectedMessageId="assistant-1"
      />,
    )

    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Open source 1: Source 1"')
    expect(html).not.toContain('</button><button')
  })

  it('renders structured suggestions outside the assistant message body', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            suggestions: [
              { text: 'What parser rules do the docs cover?', kind: 'deeper' },
              { text: 'Which onboarding questions are answered?', kind: 'broader' },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Answer text')
    expect(html).toContain('Deeper')
    expect(html).toContain('Broader')
    expect(html).toContain('What parser rules do the docs cover?')
    expect(html).toContain('Which onboarding questions are answered?')
  })

  it('treats legacy flat suggestions as deeper suggestions for history compatibility', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            suggestions: [
              { text: 'What parser rules do the docs cover?' },
              { text: 'Which onboarding questions are answered?' },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Deeper')
    expect(html).not.toContain('Broader')
    expect(html).toContain('What parser rules do the docs cover?')
    expect(html).toContain('Which onboarding questions are answered?')
  })

  it('omits empty suggestion groups when only broader suggestions are supported', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            suggestions: [
              { text: 'How does this connect to the broader workflow?', kind: 'broader' },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toContain('Deeper')
    expect(html).toContain('Broader')
    expect(html).toContain('How does this connect to the broader workflow?')
  })

  it('renders custom suggestion group labels when provided', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Risposta',
            createdAt: '2026-04-02T10:00:00.000Z',
            suggestions: [
              { text: 'Quali regole cita la guida?', kind: 'deeper' },
              { text: 'Quali temi adiacenti sono supportati?', kind: 'broader' },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
        suggestionGroupLabels={{ deeper: 'Approfondisci', broader: 'Allarga' }}
      />,
    )

    expect(html).toContain('Approfondisci')
    expect(html).toContain('Allarga')
    expect(html).not.toContain('Deeper')
    expect(html).not.toContain('Broader')
  })

  it('renders inline pseudo-lists as markdown lists for assistant messages', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content:
              'If you want, I can help with: - a simple yoga or meditation routine - what gear is useful for practice - Ananda Yoga topics and recordings',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('<ul')
    expect(html).toContain('<li')
    expect(html).toContain('a simple yoga or meditation routine')
    expect(html).toContain('what gear is useful for practice')
    expect(html).toContain('Ananda Yoga topics and recordings')
  })
})
