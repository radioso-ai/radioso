type Edition = 'oss' | 'enterprise'
type HistoryFilter = 'all' | 'chat' | 'search' | 'contact'

const parseEdition = (value: string | undefined): Edition =>
  value === 'enterprise' ? 'enterprise' : 'oss'

const edition = parseEdition(process.env.NEXT_PUBLIC_RADIOSO_EDITION)
const isEnterprise = edition === 'enterprise'

export const editionController = {
  edition,

  canCreateAdditionalOrganizations: () => isEnterprise,
  canUseEnterpriseUsageLimits: () => isEnterprise,
  canHideAssistantBranding: () => isEnterprise,
  canUseAssistantAnswerFeedback: () => true,
  canUseAgentCreationExtensions: () => true,

  shouldRenderWebsiteEmbedSettings: (mode: 'workspace' | 'assistant' | 'channels') =>
    mode === 'channels',

  getActivityDescription: () =>
    'Review past chats and searches. Retrieval diagnostics live here.',

  getActivityFilterOptions: () =>
    [
      { value: 'all' as const, label: 'All' },
      { value: 'chat' as const, label: 'Chats' },
      { value: 'search' as const, label: 'Searches' },
    ],

  normalizeHistoryFilter: (filter: HistoryFilter): HistoryFilter =>
    filter === 'contact' ? 'all' : filter,

  normalizeHistorySelection: <T extends { kind: string } | null>(item: T): T | null =>
    item?.kind === 'contact' ? null : item,

  filterActivityItems: <T extends { kind: string }>(items: readonly T[]): T[] =>
    items.filter((item) => item.kind !== 'contact'),
}
