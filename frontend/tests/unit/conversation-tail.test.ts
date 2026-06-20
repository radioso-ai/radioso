import { describe, expect, it } from 'vitest'

import type { ChatConversationMessage } from '@/lib/api-types'
import { mergeTailMessages } from '@/lib/conversation-tail'

const message = (
  id: string,
  createdAt: string,
  content = id,
): ChatConversationMessage => ({
  id,
  role: 'assistant',
  source: 'ai_agent',
  content,
  createdAt,
})

describe('mergeTailMessages', () => {
  it('appends incoming messages in chronological order', () => {
    const existing = [message('message-1', '2026-06-18T10:00:00.000Z')]
    const incoming = [
      message('message-3', '2026-06-18T10:02:00.000Z'),
      message('message-2', '2026-06-18T10:01:00.000Z'),
    ]

    expect(mergeTailMessages(existing, incoming).map((item) => item.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ])
  })

  it('dedupes by id with incoming messages winning', () => {
    const existing = [
      message('message-1', '2026-06-18T10:00:00.000Z', 'old'),
      message('message-2', '2026-06-18T10:01:00.000Z'),
    ]
    const incoming = [
      message('message-1', '2026-06-18T10:00:00.000Z', 'new'),
    ]

    expect(mergeTailMessages(existing, incoming)).toEqual([
      message('message-1', '2026-06-18T10:00:00.000Z', 'new'),
      message('message-2', '2026-06-18T10:01:00.000Z'),
    ])
  })

  it('orders equal timestamps by id', () => {
    const existing = [message('message-b', '2026-06-18T10:00:00.000Z')]
    const incoming = [message('message-a', '2026-06-18T10:00:00.000Z')]

    expect(mergeTailMessages(existing, incoming).map((item) => item.id)).toEqual([
      'message-a',
      'message-b',
    ])
  })

  it('does not mutate input arrays', () => {
    const existing = [message('message-2', '2026-06-18T10:01:00.000Z')]
    const incoming = [message('message-1', '2026-06-18T10:00:00.000Z')]
    const existingBefore = [...existing]
    const incomingBefore = [...incoming]

    mergeTailMessages(existing, incoming)

    expect(existing).toEqual(existingBefore)
    expect(incoming).toEqual(incomingBefore)
  })
})
