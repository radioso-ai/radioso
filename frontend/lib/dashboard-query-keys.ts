import type {
  GetQualityStatsOptions,
  ListLowQualityTurnsOptions,
  QualityActionFilter,
} from './api-quality'
import type { ConversationSearchParams } from './conversation-filters'

/**
 * Canonical keys for dashboard data which is accelerated by workspace
 * invalidations. They intentionally mirror request inputs, not route labels.
 */
export type DashboardQueryKey = readonly unknown[]

export type HistoryVariant = 'all' | 'chat' | 'contact' | 'search'

/** The list endpoint speaks offset/limit; dashboard callers speak pages. */
export type QualityTurnsQueryInput = Omit<ListLowQualityTurnsOptions, 'limit' | 'offset'> & {
  page: number
  pageSize: number
}

const workspaceKey = (workspaceId: string, ...parts: readonly unknown[]) =>
  ['workspace', workspaceId, ...parts] as const

const optional = <T>(value: T | undefined) => value === undefined ? null : value

const normalizeSet = <T extends string>(values: T | readonly T[] | undefined) => {
  const source = values === undefined ? [] : typeof values === 'string' ? [values] : values
  return source.length === 0 ? null : [...new Set(source)].sort()
}

const normalizeActions = (actions: readonly QualityActionFilter[] | undefined) => {
  if (!actions || actions.length === 0) return null
  return [...new Map(actions.map(({ skillName, outcome }) => [
    `${skillName}\u0000${outcome}`,
    [skillName, outcome] as const,
  ])).values()].sort(([leftSkill, leftOutcome], [rightSkill, rightOutcome]) =>
    leftSkill === rightSkill ? leftOutcome.localeCompare(rightOutcome) : leftSkill.localeCompare(rightSkill))
}

export const dashboardQueryKeys = {
  documents: {
    list: (workspaceId: string, input: { page: number; pageSize: number; sourceId: string | null }) =>
      workspaceKey(workspaceId, 'documents', 'list', input.sourceId, input.page, input.pageSize),
    crawlActivity: (workspaceId: string, input: { recentSinceMinutes: number }) =>
      workspaceKey(workspaceId, 'documents', 'crawl-activity', input.recentSinceMinutes),
  },
  sources: {
    list: (workspaceId: string) => workspaceKey(workspaceId, 'sources', 'list'),
    crawlState: (workspaceId: string) => workspaceKey(workspaceId, 'sources', 'crawl-state'),
  },
  history: {
    // `searchParams` is only meaningful for the 'all' variant's merged feed (issue #1126);
    // omitted (not just empty), the key matches exactly what it was before that feature —
    // callers for 'chat'/'search'/'contact' pass nothing and keep their existing cache keys.
    list: (workspaceId: string, input: { page: number; pageSize: number; variant: HistoryVariant; searchParams?: ConversationSearchParams }) =>
      workspaceKey(
        workspaceId, 'history', 'list', input.variant, input.page, input.pageSize,
        ...(input.searchParams ? [
          optional(input.searchParams.q),
          optional(input.searchParams.outcome),
          optional(input.searchParams.agentId),
          optional(input.searchParams.sourceOrigin),
        ] : []),
      ),
  },
  quality: {
    stats: (workspaceId: string, input: GetQualityStatsOptions) =>
      workspaceKey(workspaceId, 'quality', 'stats', optional(input.range), optional(input.agentId), optional(input.channel)),
    turns: (workspaceId: string, input: QualityTurnsQueryInput) =>
      workspaceKey(
        workspaceId,
        'quality',
        'turns',
        normalizeSet(input.signal),
        normalizeActions(input.actions),
        normalizeSet(input.statuses),
        normalizeSet(input.feedback),
        normalizeSet(input.triageStates),
        normalizeSet(input.resolutionReasons),
        optional(input.sort),
        optional(input.activeNegativeFeedbackOnly),
        optional(input.hasComment),
        optional(input.minTotalLatencyMs),
        optional(input.maxTotalLatencyMs),
        normalizeSet(input.groundingVerdict),
        optional(input.hasUnsourcedClaims),
        optional(input.hasInvalidSources),
        optional(input.from),
        optional(input.to),
        optional(input.resolutionFrom),
        optional(input.resolutionTo),
        input.page,
        input.pageSize,
      ),
  },
  attention: {
    decisions: (workspaceId: string) => workspaceKey(workspaceId, 'attention', 'decisions'),
    humanOwned: (workspaceId: string, input: { pageSize: number }) =>
      workspaceKey(workspaceId, 'attention', 'human-owned', input.pageSize),
    recentlyClosed: (workspaceId: string, input: { limit: number }) =>
      workspaceKey(workspaceId, 'attention', 'recently-closed', input.limit),
    // No workspace event reports a delivery failure yet, so it polls, and an operator's own
    // acknowledgement re-reads it by invalidating this key.
    deliveryFailures: (workspaceId: string, input: { limit: number }) =>
      workspaceKey(workspaceId, 'attention', 'delivery-failures', input.limit),
    // Held replies poll for the same reason, and an operator's own release, discard or reply
    // re-reads them by invalidating this key.
    heldReplies: (workspaceId: string, input: { limit: number }) =>
      workspaceKey(workspaceId, 'attention', 'held-replies', input.limit),
  },
  conversations: {
    // Not a live-invalidation family: no workspace event reports a teammate change, so
    // callers re-read it by invalidating this key.
    operators: (workspaceId: string) => workspaceKey(workspaceId, 'conversations', 'operators'),
    // Polled while the conversation is open, and re-read after an operator's own action on it.
    emailFacts: (workspaceId: string, conversationId: string) =>
      workspaceKey(workspaceId, 'conversations', 'email-facts', conversationId),
    // Polled while the conversation is open, so a newer draft or a teammate's release shows.
    heldReply: (workspaceId: string, conversationId: string) =>
      workspaceKey(workspaceId, 'conversations', 'held-reply', conversationId),
  },
} as const

type DashboardQueryFamily =
  | 'documents/list'
  | 'documents/crawl-activity'
  | 'sources/list'
  | 'sources/crawl-state'
  | 'history/list'
  | 'quality/stats'
  | 'quality/turns'
  | 'attention/decisions'
  | 'attention/human-owned'
  | 'attention/recently-closed'
  | 'attention/delivery-failures'
  | 'attention/held-replies'

const knownFamilies = new Set<DashboardQueryFamily>([
  'documents/list',
  'documents/crawl-activity',
  'sources/list',
  'sources/crawl-state',
  'history/list',
  'quality/stats',
  'quality/turns',
  'attention/decisions',
  'attention/human-owned',
  'attention/recently-closed',
  'attention/delivery-failures',
  'attention/held-replies',
])

export const isDashboardQueryFamily = (
  key: DashboardQueryKey,
  workspaceId: string,
  family: DashboardQueryFamily,
) => {
  const [area, variant] = family.split('/')
  return key[0] === 'workspace'
    && key[1] === workspaceId
    && key[2] === area
    && key[3] === variant
}

export const isDashboardQueryKey = (key: DashboardQueryKey, workspaceId: string) => {
  const [area, variant] = [key[2], key[3]]
  if (typeof area !== 'string' || typeof variant !== 'string') return false
  const family = `${area}/${variant}` as DashboardQueryFamily
  return knownFamilies.has(family) && isDashboardQueryFamily(key, workspaceId, family)
}

export const historyVariantForKey = (key: DashboardQueryKey, workspaceId: string): HistoryVariant | null => {
  if (!isDashboardQueryFamily(key, workspaceId, 'history/list')) return null
  const variant = key[4]
  return variant === 'all' || variant === 'chat' || variant === 'contact' || variant === 'search'
    ? variant
    : null
}
