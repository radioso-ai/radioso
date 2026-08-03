import { describe, expect, it } from 'vitest'

import {
  formatConversationChannelContextDetails,
  formatConversationLocation,
  formatConversationSource,
  getConversationSourceBadge,
} from '@/lib/history-source'
import type { ChatConversationSummary } from '@/lib/api'

const conversation = (
  overrides: Partial<ChatConversationSummary> = {},
): Pick<ChatConversationSummary, 'sourceChannel' | 'sourceOrigin' | 'channelContext' | 'entryPageUrl' | 'anonymousSessionId'> => ({
  sourceChannel: 'authenticated_chat',
  sourceOrigin: null,
  channelContext: null,
  entryPageUrl: null,
  anonymousSessionId: null,
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
    expect(formatConversationLocation(input).text).toBe('Direct message with Dana')
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
    expect(formatConversationLocation(input).text).toBe('Channel C123 · thread · U123')
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

  it('uses the entry page path and keeps the full URL openable', () => {
    expect(formatConversationLocation(conversation({
      sourceChannel: 'website_embed',
      sourceOrigin: 'https://it.ananda.eu',
      entryPageUrl: 'https://it.ananda.eu/courses/yoga/?utm_source=chat#overview',
    }))).toEqual({
      text: 'it.ananda.eu/courses/yoga',
      href: 'https://it.ananda.eu/courses/yoga/?utm_source=chat#overview',
      title: 'https://it.ananda.eu/courses/yoga/?utm_source=chat#overview',
    })
  })

  it('falls back to the parsed origin or channel when the entry URL is invalid', () => {
    expect(formatConversationLocation(conversation({
      sourceChannel: 'website_embed',
      sourceOrigin: 'https://it.ananda.eu',
      entryPageUrl: 'not a URL',
    }))).toEqual({
      text: 'it.ananda.eu',
      href: 'https://it.ananda.eu',
      title: 'https://it.ananda.eu',
    })

    expect(formatConversationLocation(conversation({
      sourceChannel: 'authenticated_chat',
      entryPageUrl: 'not a URL',
    }))).toEqual({ text: 'Dashboard chat', href: null, title: null })
  })

  it('keeps the channel location vocabulary stable', () => {
    expect(formatConversationLocation(conversation({ sourceChannel: 'authenticated_chat' })).text).toBe('Dashboard chat')
  })
})
