import { useQuery, type QueryClient } from '@tanstack/react-query'

import type {
  GetQualityStatsOptions,
  ListLowQualityTurnsOptions,
  LowQualityTurnsPage,
  QualityActionFilter,
  QualityTriageRecord,
} from './api-quality'
import { qualityApi } from './api-quality'
import { isTerminalQualityTriageState } from './quality-signals'
import { dashboardQueryKeys, type QualityTurnsQueryInput } from './dashboard-query-keys'

export type QualityTurnsRequest = Omit<QualityTurnsQueryInput, 'page' | 'pageSize'> & {
  page: number
  pageSize: number
}

const normalizeSet = <T extends string>(values: readonly T[] | undefined) =>
  values && values.length > 0 ? [...new Set(values)].sort() : undefined

const normalizeActions = (actions: readonly QualityActionFilter[] | undefined) => {
  if (!actions || actions.length === 0) return undefined
  return [...new Map(actions.map((action) => [`${action.skillName}\u0000${action.outcome}`, action])).values()]
    .sort((left, right) => left.skillName.localeCompare(right.skillName) || left.outcome.localeCompare(right.outcome))
}

/** One request-equivalent shape feeds both the transport and canonical key. */
export const normalizeQualityTurnsRequest = (input: QualityTurnsRequest): QualityTurnsRequest => ({
  ...input,
  signal: normalizeSet(typeof input.signal === 'string' ? [input.signal] : input.signal) as QualityTurnsRequest['signal'],
  actions: normalizeActions(input.actions),
  statuses: normalizeSet(input.statuses),
  feedback: normalizeSet(input.feedback),
  triageStates: normalizeSet(input.triageStates),
  resolutionReasons: normalizeSet(input.resolutionReasons),
  groundingVerdict: normalizeSet(typeof input.groundingVerdict === 'string' ? [input.groundingVerdict] : input.groundingVerdict) as QualityTurnsRequest['groundingVerdict'],
  sort: input.sort === 'turn_created_at' ? undefined : input.sort,
  activeNegativeFeedbackOnly: input.activeNegativeFeedbackOnly || undefined,
  hasComment: input.hasComment || undefined,
  hasUnsourcedClaims: input.hasUnsourcedClaims || undefined,
  hasInvalidSources: input.hasInvalidSources || undefined,
})

export const qualityTurnsApiOptions = (input: QualityTurnsRequest): ListLowQualityTurnsOptions => {
  const normalized = normalizeQualityTurnsRequest(input)
  const { page, pageSize, ...filters } = normalized
  return {
    ...filters,
    limit: pageSize,
    offset: Math.max(0, page - 1) * pageSize,
  }
}

export const useQualityStatsQuery = (
  workspaceId: string,
  input: GetQualityStatsOptions,
  enabled: boolean,
  floorMs: number,
) => {
  const queryKey = dashboardQueryKeys.quality.stats(workspaceId, input)
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => qualityApi.getStats(input, signal),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: floorMs,
  })
  return { ...query, queryKey }
}

export const useQualityTurnsQuery = (
  workspaceId: string,
  input: QualityTurnsRequest,
  enabled: boolean,
  floorMs: number,
) => {
  const normalized = normalizeQualityTurnsRequest(input)
  const queryKey = dashboardQueryKeys.quality.turns(workspaceId, normalized)
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => qualityApi.listTurns(qualityTurnsApiOptions(normalized), signal),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: floorMs,
  })
  return { ...query, normalized, queryKey }
}

export type FrozenQualityPage = { queryKey: readonly unknown[]; page: LowQualityTurnsPage }
export type QualityMutationInteraction = { id: number; queryKey: readonly unknown[] }

export const ownsQualityInteraction = (currentId: number, interactionId: number) => currentId === interactionId
export const beginQualityInteraction = (currentId: number) => currentId + 1

export type QualityInteractionController = { currentId: number; frozenId: number | null }

/** Small, UI-neutral ordering model for mutation completion ownership. */
export const beginQualityInteractionController = (state: QualityInteractionController) => {
  const id = beginQualityInteraction(state.currentId)
  return { state: { currentId: id, frozenId: id }, id, effects: ['freeze'] as const }
}

export const settleQualityInteraction = ({
  currentId,
  interactionId,
  outcome,
  patch,
  invalidate,
  present,
}: {
  currentId: number
  interactionId: number
  outcome: 'success' | 'conflict' | 'failure' | 'cancel'
  patch?: () => void
  invalidate?: () => void
  present?: () => void
}) => {
  if (outcome === 'success' || outcome === 'conflict') {
    patch?.()
    invalidate?.()
  }
  if (ownsQualityInteraction(currentId, interactionId)) present?.()
}

export const qualityTurnRemainsVisible = (
  turn: LowQualityTurnsPage['items'][number],
  triage: QualityTriageRecord,
  request: QualityTurnsRequest,
) => {
  if (request.activeNegativeFeedbackOnly && isTerminalQualityTriageState(triage.state)) return false
  if (request.triageStates && !request.triageStates.includes(triage.state)) return false
  const reason = triage.resolution?.reason ?? 'unspecified'
  if (request.resolutionReasons && !request.resolutionReasons.includes(reason)) return false
  const closedAt = triage.closedAt ? Date.parse(triage.closedAt) : Number.NaN
  if (request.resolutionFrom && (Number.isNaN(closedAt) || closedAt < Date.parse(request.resolutionFrom))) return false
  if (request.resolutionTo && (Number.isNaN(closedAt) || closedAt >= Date.parse(request.resolutionTo))) return false
  return Boolean(turn)
}

export const frozenQualityPageForKey = (
  frozen: FrozenQualityPage | null,
  queryKey: readonly unknown[],
) => frozen && JSON.stringify(frozen.queryKey) === JSON.stringify(queryKey) ? frozen.page : null

export const patchQualityTriage = (
  client: QueryClient,
  queryKey: readonly unknown[],
  assistantMessageId: string,
  triage: QualityTriageRecord,
  remove: boolean,
  fallback?: LowQualityTurnsPage['items'][number],
) => client.setQueryData<LowQualityTurnsPage>(queryKey, (page) => {
  if (!page) return page
  const exists = page.items.some((item) => item.assistantMessageId === assistantMessageId)
  const items = remove && exists
    ? page.items.filter((item) => item.assistantMessageId !== assistantMessageId)
    : exists
      ? page.items.map((item) => item.assistantMessageId === assistantMessageId ? { ...item, triage } : item)
      : fallback ? [...page.items, { ...fallback, triage }] : page.items
  const total = remove && exists ? Math.max(0, page.total - 1) : !remove && !exists && fallback ? page.total + 1 : page.total
  return { ...page, items, total, totalPages: total === 0 ? 0 : Math.ceil(total / page.pageSize) }
})
