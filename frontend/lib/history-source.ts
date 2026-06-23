import type { ChatConversationSummary, ConversationChannelContext } from '@/lib/api'

export interface ConversationSourceBadge {
  className: string
  label: string
}

export const SOURCE_BADGES: Record<string, ConversationSourceBadge> = {
  slack: {
    className: 'rounded-full bg-violet-500/15 px-2.5 py-1 text-violet-700 dark:text-violet-300',
    label: 'Slack',
  },
  anonymous: {
    className: 'rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-700 dark:text-amber-400',
    label: 'Anonymous',
  },
  website_embed: {
    className: 'rounded-full bg-sky-500/15 px-2.5 py-1 text-sky-700 dark:text-sky-300',
    label: 'Embedded',
  },
  mcp: {
    className: 'rounded-full bg-emerald-500/15 px-2.5 py-1 text-emerald-700 dark:text-emerald-300',
    label: 'MCP',
  },
}

type ConversationSourceInput = Pick<ChatConversationSummary, 'sourceChannel' | 'sourceOrigin' | 'channelContext'>

const isConversationSourceInput = (
  input: ConversationSourceInput | string | null,
): input is ConversationSourceInput =>
  typeof input === 'object' && input !== null && 'sourceChannel' in input && 'sourceOrigin' in input

const trimToValue = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

const slackUserLabel = (context: Extract<ConversationChannelContext, { provider: 'slack' }>) =>
  trimToValue(context.user.displayName) ?? context.user.id

export const getConversationSourceBadge = (
  input: ConversationSourceInput | string | null,
): ConversationSourceBadge | null => {
  if (isConversationSourceInput(input) && input.channelContext?.provider === 'slack') {
    return SOURCE_BADGES.slack
  }

  const sourceChannel = isConversationSourceInput(input) ? input.sourceChannel : input
  return sourceChannel ? SOURCE_BADGES[sourceChannel] ?? null : null
}

export const formatConversationChannelContextDetails = (
  channelContext: ConversationChannelContext | null | undefined,
): string[] => {
  if (channelContext?.provider !== 'slack') {
    return []
  }

  const details = [`Team ${trimToValue(channelContext.team.name) ?? channelContext.team.id}`]
  if (channelContext.channel.type === 'im') {
    details.push(`Direct message with ${slackUserLabel(channelContext)}`)
  } else {
    details.push(`Channel ${channelContext.channel.id}`)
    details.push(`User ${slackUserLabel(channelContext)}`)
  }
  if (channelContext.threadTs) {
    details.push('Thread')
  }

  return details
}

const formatSlackConversationSource = (
  context: Extract<ConversationChannelContext, { provider: 'slack' }>,
) => {
  const suffix = context.channel.type === 'im'
    ? `Direct message with ${slackUserLabel(context)}`
    : `Channel ${context.channel.id}${context.threadTs ? ' · thread' : ''} · ${slackUserLabel(context)}`

  return `Slack · ${suffix}`
}

export function formatConversationSource(conversation: ConversationSourceInput): string | null
export function formatConversationSource(sourceChannel: string | null, sourceOrigin: string | null): string | null
export function formatConversationSource(
  input: ConversationSourceInput | string | null,
  sourceOrigin?: string | null,
) {
  if (isConversationSourceInput(input) && input.channelContext?.provider === 'slack') {
    return formatSlackConversationSource(input.channelContext)
  }

  const sourceChannel = isConversationSourceInput(input) ? input.sourceChannel : input
  const origin = isConversationSourceInput(input) ? input.sourceOrigin : sourceOrigin ?? null

  if (sourceChannel === 'website_embed' && origin) {
    try {
      return `Embedded from ${new URL(origin).host}`
    } catch {
      return `Embedded from ${origin}`
    }
  }

  if (sourceChannel === 'website_embed') {
    return 'Embedded chat'
  }

  if (sourceChannel === 'anonymous') {
    return 'Anonymous public chat'
  }

  if (sourceChannel === 'mcp') {
    return 'MCP'
  }

  if (sourceChannel === 'authenticated_chat') {
    return null
  }

  return sourceChannel
}
