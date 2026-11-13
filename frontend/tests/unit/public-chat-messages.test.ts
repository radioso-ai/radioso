import { describe, expect, it } from 'vitest'

import type { ChatConversationDetail } from '@/lib/api'
import { DEFAULT_WEBSITE_EMBED_COPY } from '@/lib/embed-widget'
import { resolveBuiltInEmbedCopy } from '@/lib/embed-locale-packs'
import { toChatMessagesFromTurns, visitorThreadMessages, type ChatMessage } from '@/lib/public-chat-messages'

const turn = (message: Partial<ChatConversationDetail['messages'][number]> & { id: string }): ChatConversationDetail['messages'][number] => ({
  role: 'user',
  content: '',
  createdAt: '2026-11-12T10:00:00.000Z',
  ...message,
}) as ChatConversationDetail['messages'][number]

describe('the visitor thread after a consent was withdrawn', () => {
  const withheld = { reason: 'consent_withdrawn' as const, at: '2026-11-12T10:05:00.000Z' }

  it('carries which messages the history says were withheld', () => {
    const messages = toChatMessagesFromTurns([
      turn({ id: 'stated', content: '[redacted]', withheld }),
      turn({ id: 'reply', role: 'assistant', content: '[redacted]', withheld }),
      turn({ id: 'other', content: 'When is the next class?' }),
    ])

    expect(messages.map((message) => [message.id, message.withheld ?? false])).toEqual([
      ['stated', true],
      ['reply', true],
      ['other', false],
    ])
  })

  it('shows the label in the visitor\'s language in place of the redaction marker', () => {
    const messages: ChatMessage[] = [
      { id: 'stated', role: 'user', content: '[redacted]', createdAt: '2026-11-12T10:00:00.000Z', status: 'complete', withheld: true },
      { id: 'other', role: 'assistant', content: 'Tuesday works.', createdAt: '2026-11-12T10:01:00.000Z', status: 'complete' },
    ]

    expect(visitorThreadMessages(messages, DEFAULT_WEBSITE_EMBED_COPY).map((message) => message.content))
      .toEqual(['Withheld after consent was withdrawn', 'Tuesday works.'])
    const german = { ...DEFAULT_WEBSITE_EMBED_COPY, ...resolveBuiltInEmbedCopy(['de']) }
    expect(visitorThreadMessages(messages, german)[0]?.content).toBe(german.publicChatWithheldMessageLabel)
    expect(german.publicChatWithheldMessageLabel).not.toBe(DEFAULT_WEBSITE_EMBED_COPY.publicChatWithheldMessageLabel)
  })

  it('still shows the failure copy for a turn that failed before any text', () => {
    const failed: ChatMessage = { id: 'failed', role: 'assistant', content: '', createdAt: '2026-11-12T10:00:00.000Z', status: 'error', failure: 'unavailable' }

    expect(visitorThreadMessages([failed], DEFAULT_WEBSITE_EMBED_COPY)[0]?.content)
      .toBe(DEFAULT_WEBSITE_EMBED_COPY.publicChatAgentUnavailableMessage)
    expect(visitorThreadMessages([{ ...failed, failure: undefined }], DEFAULT_WEBSITE_EMBED_COPY)[0]?.content)
      .toBe(DEFAULT_WEBSITE_EMBED_COPY.publicChatMessageFailedMessage)
  })
})
