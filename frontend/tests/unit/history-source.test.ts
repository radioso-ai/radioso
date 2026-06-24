import { describe, expect, it } from 'vitest'

import {
  formatConversationChannelContextDetails,
  formatConversationSource,
  getConversationSourceBadge,
} from '@/lib/history-source'
import type { ChatConversationSummary } from '@/lib/api'

const conversation = (
  overrides: Partial<ChatConversationSummary> = {},
): Pick<ChatConversationSummary, 'sourceChannel' | 'sourceOrigin' | 'channelContext'> => ({
  sourceChannel: 'authenticated_chat',
  sourceOrigin: null,
  channelContext: null,
  ...overrides,
})

describe('history source formatting', () => {
  it('formats Slack direct messages without falling back to authenticated chat', () => {
    const input = conversation({
      channelContext: {
        provider: 'slack',
        team: { id: 'T123', name: 'Ausalt' },
        channel: { id: 'D123', type: 'im' },
        user: { id: 'U123', displayName: 'Dana' },
      },
    })

    expect(getConversationSourceBadge(input)?.label).toBe('Slack')
    expect(formatConversationSource(input)).toBe('Slack · Direct message with Dana')
    expect(formatConversationChannelContextDetails(input.channelContext)).toEqual([
      'Team Ausalt',
      'Direct message with Dana',
    ])
  })

  it('formats Slack channel threads with channel, user, and thread context', () => {
    const input = conversation({
      channelContext: {
        provider: 'slack',
        team: { id: 'T123' },
        channel: { id: 'C123', type: 'channel' },
        threadTs: '1712345678.000100',
        user: { id: 'U123' },
      },
    })

    expect(getConversationSourceBadge(input)?.label).toBe('Slack')
    expect(formatConversationSource(input)).toBe('Slack · Channel C123 · thread · U123')
    expect(formatConversationChannelContextDetails(input.channelContext)).toEqual([
      'Team T123',
      'Channel C123',
      'User U123',
      'Thread',
    ])
  })

  it('falls back to the existing source-channel behavior when channel context is absent', () => {
    expect(formatConversationSource(conversation())).toBeNull()
    expect(formatConversationSource(conversation({ sourceChannel: 'anonymous' }))).toBe('Anonymous public chat')
    expect(getConversationSourceBadge(conversation({ sourceChannel: 'anonymous' }))?.label).toBe('Anonymous')
  })
})
