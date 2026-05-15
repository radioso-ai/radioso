import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'

const UTILITY_BUTTON_LABELS = /aria-label="(Copy message|Copied|Thumbs up|Thumbs down)"/

const countSuggestionButtons = (html: string) =>
  (html.match(/<button[^>]*>/g) ?? []).filter((tag) => !UTILITY_BUTTON_LABELS.test(tag)).length

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
    expect(countSuggestionButtons(html)).toBe(0)
  })

  it('renders legacy flat suggestions for history compatibility', () => {
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

    expect(countSuggestionButtons(html)).toBe(0)
  })

  it('renders suggestions even when only broader items are provided', () => {
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

    expect(html).toContain('Answer text')
  })

  it('preserves real list items with hyphenated markdown link labels', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '- **[Ananda Yoga in silenzio - 3 Giorni](https://example.com/course)**',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html.match(/<li/g)?.length).toBe(1)
    expect(html).toContain('Ananda Yoga in silenzio - 3 Giorni')
  })

  it('renders text suggestions as buttons when selection is enabled', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            suggestions: [{ text: 'Which onboarding questions are answered?', kind: 'broader' }],
          },
        ]}
        onOpenDocument={async () => 'opened'}
        onSuggestionSelect={() => {}}
      />,
    )

    expect(countSuggestionButtons(html)).toBe(1)
  })

  it('can hide assistant message avatars for narrow embedded chat layouts', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
        assistantAvatarUrl="https://cdn.example.com/avatar.png"
        assistantAvatarLabel="Support assistant"
        hideAssistantAvatar
      />,
    )

    expect(html).toContain('Answer text')
    expect(html).not.toContain('Support assistant')
    expect(html).not.toContain('https://cdn.example.com/avatar.png')
  })

  it('omits empty suggestion text entries', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            suggestions: [
              { text: '   ', kind: 'deeper' },
              { text: 'Which onboarding questions are answered?', kind: 'broader' },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
        onSuggestionSelect={() => {}}
      />,
    )

    expect(countSuggestionButtons(html)).toBe(1)
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
  })

  it('does not split hyphenated markdown link labels inside real list items', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content:
              'Ananda offers several ways to explore **Ananda Yoga**:\n\n- A **3-day intensive residential course**, **[Ananda Yoga in silenzio - 3 Giorni](https://corsi.ananda.it/corso/0008136-corso-residenziale-intensivo-ananda-yoga-in-silenzio-3-giorni)**, focused on deeper practice.\n- For learning more, see **[Ananda Yoga videos](https://anandaeurope.org/video/guided-ananda-yoga)**.',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html.match(/<li/g)?.length).toBe(2)
    expect(html).toContain('Ananda Yoga in silenzio - 3 Giorni')
    expect(html).not.toContain('3 Giorni]</li>')
  })

  it('renders answer feedback controls when handlers are provided', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            persistedAssistantMessageId: 'persisted-assistant-1',
          },
        ]}
        onOpenDocument={async () => 'opened'}
        onAnswerFeedback={() => {}}
        onClearAnswerFeedback={() => {}}
      />,
    )

    expect(html).toContain('aria-label="Thumbs up"')
    expect(html).toContain('aria-label="Thumbs down"')
  })

  it('does not render answer feedback controls for unpersisted assistant messages', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'client-bootstrap-assistant-1',
            role: 'assistant',
            content: 'Bootstrap greeting',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
        onAnswerFeedback={() => {}}
        onClearAnswerFeedback={() => {}}
      />,
    )

    expect(html).not.toContain('aria-label="Thumbs up"')
    expect(html).not.toContain('aria-label="Thumbs down"')
  })

  it('renders per-message feedback comments in history', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Answer text',
            createdAt: '2026-04-02T10:00:00.000Z',
            answerFeedbackEntries: [
              {
                id: 'feedback-1',
                value: 'down',
                comment: 'This missed the policy detail.',
                actorType: 'anonymous_user',
                actorId: 'session-1',
                accountId: null,
                userId: null,
                anonymousSessionId: 'session-1',
                createdAt: '2026-04-02T10:01:00.000Z',
                updatedAt: '2026-04-02T10:01:00.000Z',
              },
            ],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Thumbs down')
    expect(html).toContain('This missed the policy detail.')
  })

})
