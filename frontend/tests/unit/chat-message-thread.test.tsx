import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { appendAssistantLinkUtm, ChatMessageThread } from '@/components/dashboard/chat-message-thread'

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

  it('adds Radioso UTM attribution to assistant-authored answer links', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '[Read more](https://example.com/docs?existing=1#intro)',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
        assistantAvatarLabel="Support Bot"
      />,
    )

    expect(html).toContain('utm_source=radioso')
    expect(html).toContain('utm_medium=support_bot_agent')
    expect(html).toContain('existing=1')
    expect(html).toContain('#intro')
  })

  it('preserves non-Latin assistant names in UTM medium attribution', () => {
    const url = new URL(appendAssistantLinkUtm('https://example.com/docs', '東京 サポート'))

    expect(url.searchParams.get('utm_source')).toBe('radioso')
    expect(url.searchParams.get('utm_medium')).toBe('東京_サポート_agent')
  })

  it('leaves assistant-authored answer links unchanged when UTM attribution is disabled', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '[Read more](https://example.com/docs?existing=1#intro)',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ]}
        onOpenDocument={async () => 'opened'}
        assistantAvatarLabel="Support Bot"
        assistantLinkUtmEnabled={false}
      />,
    )

    expect(html).toContain('href="https://example.com/docs?existing=1#intro"')
    expect(html).not.toContain('utm_source=radioso')
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

  it('renders eval capture only when the operator surface opts in', () => {
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
        conversationId="conversation-1"
        evalCaptureEnabled
      />,
    )

    expect(html).toContain('aria-label="Send to eval"')
  })

  it('does not expose eval capture on public chat or embed surfaces', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'Answer text',
      createdAt: '2026-04-02T10:00:00.000Z',
      persistedAssistantMessageId: 'persisted-assistant-1',
    }

    const publicHtml = renderToStaticMarkup(
      <ChatMessageThread
        messages={[message]}
        onOpenDocument={async () => 'opened'}
        conversationId="conversation-1"
        analyticsSurface="public_chat"
      />,
    )
    const embedHtml = renderToStaticMarkup(
      <ChatMessageThread
        messages={[message]}
        onOpenDocument={async () => 'opened'}
        conversationId="conversation-1"
        analyticsSurface="embed"
      />,
    )

    expect(publicHtml).not.toContain('aria-label="Send to eval"')
    expect(embedHtml).not.toContain('aria-label="Send to eval"')
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

  it('renders a skill chip with the localized title above the first message of a skill group', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Please share your email.',
            createdAt: '2026-04-02T10:00:00.000Z',
            skill: {
              skillName: 'human_contact.request',
              phase: 'active',
              localizedTitle: 'Связаться',
            },
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('data-skill-chip')
    expect(html).toContain('Связаться')
  })

  it('uses backend-provided display title when the localized title is missing', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Please share your email.',
            createdAt: '2026-04-02T10:00:00.000Z',
            skill: {
              skillName: 'human_contact.request',
              phase: 'active',
              display: {
                icon: 'handshake',
                title: 'Contact us',
              },
            },
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Contact us')
  })

  it('uses catalog display metadata when stream payload display is absent', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Please share your email.',
            createdAt: '2026-04-02T10:00:00.000Z',
            skill: {
              skillName: 'human_contact.request',
              phase: 'active',
            },
          },
        ]}
        skillCatalog={[
          {
            name: 'human_contact.request',
            displayName: 'Contact request',
            display: {
              icon: 'handshake',
              title: 'Contact us',
            },
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Contact us')
  })

  it('renders a receipt card with captured fields when the skill phase is completed', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Your request was received.',
            createdAt: '2026-04-02T10:00:00.000Z',
            skill: {
              skillName: 'human_contact.request',
              phase: 'completed',
              localizedTitle: 'Связаться',
              receipt: {
                fields: [
                  {
                    name: 'email',
                    displayName: 'email address',
                    value: 'alex@example.com',
                  },
                ],
              },
            },
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('data-skill-receipt')
    expect(html).toContain('alex@example.com')
    expect(html).toContain('Submitted')
  })

  it('does not render a receipt card while the skill is still active', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Please share your email.',
            createdAt: '2026-04-02T10:00:00.000Z',
            skill: {
              skillName: 'human_contact.request',
              phase: 'active',
            },
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toContain('data-skill-receipt')
  })

  it('bands routine-driven turns with a start chip and an end marker when markers are supplied', () => {
    const messages = [
      { id: 'user-1', role: 'user' as const, content: 'Contact a human', createdAt: '2026-04-02T10:00:00.000Z' },
      { id: 'assistant-1', role: 'assistant' as const, content: 'What is your email?', createdAt: '2026-04-02T10:00:01.000Z' },
      { id: 'user-2', role: 'user' as const, content: 'a@b.com', createdAt: '2026-04-02T10:00:02.000Z' },
      { id: 'assistant-2', role: 'assistant' as const, content: 'Thanks, sent.', createdAt: '2026-04-02T10:00:03.000Z' },
    ]
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={messages}
        onOpenDocument={async () => 'opened'}
        routineMarkers={[
          { groupKey: null, isGroupStart: false, isGroupEnd: false },
          { groupKey: 'routine-0', isGroupStart: true, isGroupEnd: false, routineId: 'a1b2c3d4-0000-4000-8000-000000000000', routineName: 'Contact a human', routineHref: '/w/acme/agents/agent-1/routines/a1b2c3d4-0000-4000-8000-000000000000' },
          { groupKey: 'routine-0', isGroupStart: false, isGroupEnd: false, routineId: 'a1b2c3d4-0000-4000-8000-000000000000', routineName: 'Contact a human' },
          { groupKey: 'routine-0', isGroupStart: false, isGroupEnd: true, routineId: 'a1b2c3d4-0000-4000-8000-000000000000', routineName: 'Contact a human', endState: 'ended' },
        ]}
      />,
    )

    expect(html).toContain('data-routine-band="routine-0"')
    expect(html).toContain('Routine started')
    // Shows the friendly name as a link to the routine version, with the id in the tooltip.
    expect(html).toContain('Contact a human')
    expect(html).toContain('href="/w/acme/agents/agent-1/routines/a1b2c3d4-0000-4000-8000-000000000000"')
    expect(html).toContain('Routine ID: a1b2c3d4-0000-4000-8000-000000000000')
    expect(html).toContain('Routine ended')
    expect(html).not.toContain('Routine paused')
  })

  it('falls back to a humanized routine id when no name is resolved', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          { id: 'assistant-1', role: 'assistant', content: 'How can I help?', createdAt: '2026-04-02T10:00:00.000Z' },
        ]}
        onOpenDocument={async () => 'opened'}
        routineMarkers={[
          { groupKey: 'routine-0', isGroupStart: true, isGroupEnd: true, routineId: 'contact.request', endState: 'paused' },
        ]}
      />,
    )

    expect(html).toContain('Contact request')
    expect(html).toContain('Routine ID: contact.request')
    expect(html).toContain('Routine paused')
  })

  it('does not render routine chrome when no markers are supplied', () => {
    const html = renderToStaticMarkup(
      <ChatMessageThread
        messages={[
          { id: 'assistant-1', role: 'assistant', content: 'What is your email?', createdAt: '2026-04-02T10:00:00.000Z' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toContain('data-routine-band')
    expect(html).not.toContain('Routine started')
  })

})
