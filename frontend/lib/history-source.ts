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

type ConversationSourceInput = Pick<ChatConversationSummary, 'sourceChannel' | 'sourceOrigin'> & {
  channelContext?: ConversationChannelContext | null
}

type ConversationLocationInput = ConversationSourceInput & {
  entryPageUrl?: string | null
}

export interface ConversationLocation {
  /** Text for the Source cell. */
  text: string
  /** Absolute URL when the location is a real page the operator can open, else null. */
  href: string | null
  /** Full untruncated value for the title attribute, when text is elided. */
  title: string | null
}

const isConversationSourceInput = (
  input: ConversationSourceInput | string | null,
): input is ConversationSourceInput =>
  typeof input === 'object' && input !== null && 'sourceChannel' in input && 'sourceOrigin' in input

const trimToValue = (value: string | null | undefined) => {
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

const formatSlackConversationDetails = (
  context: Extract<ConversationChannelContext, { provider: 'slack' }>,
) => {
  return context.channel.type === 'im'
    ? `Direct message with ${slackUserLabel(context)}`
    : `Channel ${context.channel.id}${context.threadTs ? ' · thread' : ''} · ${slackUserLabel(context)}`
}

const formatSlackConversationSource = (
  context: Extract<ConversationChannelContext, { provider: 'slack' }>,
) => `Slack · ${formatSlackConversationDetails(context)}`

const formatSlackConversationLocation = formatSlackConversationDetails

const formatPagePath = (url: URL): string => {
  const path = url.pathname.replace(/\/+$/u, '')
  return `${url.host}${path}`
}

/** Turns conversation provenance into the one location shown to operators. */
export const formatConversationLocation = (
  conversation: ConversationLocationInput,
): ConversationLocation => {
  if (conversation.channelContext?.provider === 'slack') {
    return { text: formatSlackConversationLocation(conversation.channelContext), href: null, title: null }
  }

  const entryPageUrl = trimToValue(conversation.entryPageUrl)
  if (entryPageUrl) {
    try {
      const url = new URL(entryPageUrl)
      return { text: formatPagePath(url), href: url.toString(), title: url.toString() }
    } catch {
      // Fall through to the stable origin/channel description.
    }
  }

  const sourceOrigin = trimToValue(conversation.sourceOrigin)
  if (sourceOrigin) {
    try {
      const url = new URL(sourceOrigin)
      return { text: url.host, href: url.origin, title: url.origin }
    } catch {
      // Fall through to the channel description.
    }
  }

  switch (conversation.sourceChannel) {
    case 'website_embed':
      return { text: 'No page recorded', href: null, title: null }
    case 'anonymous':
      return { text: 'No page recorded', href: null, title: null }
    case 'mcp':
      return { text: 'No page recorded', href: null, title: null }
    case 'authenticated_chat':
    case null:
      return { text: 'Dashboard chat', href: null, title: null }
    default:
      return { text: conversation.sourceChannel, href: null, title: null }
  }
}

export function formatConversationSource(conversation: ConversationSourceInput): string | null
export function formatConversationSource(sourceChannel: string | null): string | null
export function formatConversationSource(
  input: ConversationSourceInput | string | null,
) {
  if (isConversationSourceInput(input) && input.channelContext?.provider === 'slack') {
    return formatSlackConversationSource(input.channelContext)
  }

  const sourceChannel = isConversationSourceInput(input) ? input.sourceChannel : input

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
