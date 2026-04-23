export interface ConversationSourceBadge {
  className: string
  label: string
}

const SOURCE_BADGES: Record<string, ConversationSourceBadge> = {
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

export const getConversationSourceBadge = (sourceChannel: string | null): ConversationSourceBadge | null =>
  sourceChannel ? SOURCE_BADGES[sourceChannel] ?? null : null

export const formatConversationSource = (sourceChannel: string | null, sourceOrigin: string | null) => {
  if (sourceChannel === 'website_embed' && sourceOrigin) {
    try {
      return `Embedded from ${new URL(sourceOrigin).host}`
    } catch {
      return `Embedded from ${sourceOrigin}`
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

  return sourceChannel
}
