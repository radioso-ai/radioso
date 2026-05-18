type Edition = 'oss' | 'enterprise'
type HistoryFilter = 'all' | 'chat' | 'search' | 'contact'

const parseEdition = (value: string | undefined): Edition =>
  value === 'enterprise' ? 'enterprise' : 'oss'

const edition = parseEdition(process.env.NEXT_PUBLIC_RADIOSO_EDITION)
const isEnterprise = edition === 'enterprise'

export const editionController = {
  edition,

  canUseAuthRecovery: () => isEnterprise,
  canUseEnterpriseUsageLimits: () => isEnterprise,
  canUseWebsiteEmbed: () => isEnterprise,
  canHideAssistantBranding: () => isEnterprise,
  canUseHumanContact: () => isEnterprise,
  canUseAssistantAnswerFeedback: () => isEnterprise,
  canUseAgentCreationExtensions: () => isEnterprise,

  shouldLoadHumanContactSettings: (mode: 'workspace' | 'assistant' | 'channels') =>
    isEnterprise && mode === 'assistant',

  shouldRenderWebsiteEmbedSettings: (mode: 'workspace' | 'assistant' | 'channels') =>
    isEnterprise && mode === 'channels',

  getActivityDescription: () =>
    isEnterprise
      ? 'Review past chats, searches, and contact requests. Retrieval diagnostics live here.'
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
