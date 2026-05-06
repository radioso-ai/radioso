import type { ChatSuggestion } from '@/lib/api'

type Edition = 'oss' | 'enterprise'
type HistoryFilter = 'all' | 'chat' | 'search' | 'contact'
type HumanContactSuggestion = ChatSuggestion & {
  action: NonNullable<ChatSuggestion['action']> & { kind: 'contact_human' }
}

const parseEdition = (value: string | undefined): Edition =>
  value === 'enterprise' ? 'enterprise' : 'oss'

const edition = parseEdition(process.env.NEXT_PUBLIC_RADIOSO_EDITION)
const isEnterprise = edition === 'enterprise'

const isContactSuggestion = (suggestion: ChatSuggestion) => suggestion.action?.kind === 'contact_human'

export const editionController = {
  edition,

  canUseAuthRecovery: () => isEnterprise,
  canUseEnterpriseUsageLimits: () => isEnterprise,
  canUseWebsiteEmbed: () => isEnterprise,
  canUseHumanContact: () => isEnterprise,

  shouldLoadHumanContactSettings: (mode: 'workspace' | 'assistant' | 'channels') =>
    isEnterprise && mode === 'channels',

  shouldRenderWebsiteEmbedSettings: (mode: 'workspace' | 'assistant' | 'channels') =>
    isEnterprise && mode === 'channels',

  filterChatSuggestions: <T extends ChatSuggestion>(suggestions: readonly T[] | undefined): T[] =>
    (suggestions ?? []).filter((suggestion) => isEnterprise || !isContactSuggestion(suggestion)),

  isHumanContactSuggestion: (suggestion: ChatSuggestion): suggestion is HumanContactSuggestion =>
    isEnterprise && isContactSuggestion(suggestion),

  getActivityDescription: () =>
    isEnterprise
      ? 'Review past chats, searches, and Talk to a human requests. Retrieval diagnostics live here.'
      : 'Review past chats and searches. Retrieval diagnostics live here.',

  getActivityFilterOptions: () =>
    [
      { value: 'all' as const, label: 'All' },
      { value: 'chat' as const, label: 'Chats' },
      { value: 'search' as const, label: 'Searches' },
      ...(isEnterprise ? [{ value: 'contact' as const, label: 'Human' }] : []),
    ],

  normalizeHistoryFilter: (filter: HistoryFilter): HistoryFilter =>
    !isEnterprise && filter === 'contact' ? 'all' : filter,

  normalizeHistorySelection: <T extends { kind: string } | null>(item: T): T | null =>
    !isEnterprise && item?.kind === 'contact' ? null : item,

  filterActivityItems: <T extends { kind: string }>(items: readonly T[]): T[] =>
    isEnterprise ? [...items] : items.filter((item) => item.kind !== 'contact'),
}
