'use client'

import { useQuery } from '@tanstack/react-query'

import { chatApi } from './api-chat'
import { hitlApi } from './api-hitl'
import { QUALITY_SIGNAL_IDS } from './api-quality'
import { dashboardQueryKeys } from './dashboard-query-keys'
import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { useQualityTurnsQuery, type QualityTurnsRequest } from './quality-query-state'
import type { LowQualityTurnsPage } from './api-quality'
import type { ChatConversationSummary, PendingApprovalDecision } from './api-types'
import { buildInboxModel } from './needs-attention'
import type { QualityInboxSnapshot, QualityInboxSourceAttempts } from './needs-attention-quality'
import { reduceQualityInboxSnapshot } from './needs-attention-quality'

export const reconcileAttentionOperatorResult = <T extends { id: string }>(
  conversations: readonly T[],
  result: { kind: string; conversationId?: string; ownershipState?: string; reason?: string },
): T[] => result.kind === 'ownership'
  && result.ownershipState !== 'human_owned'
  && result.conversationId
  ? conversations.filter((conversation) => conversation.id !== result.conversationId)
  : [...conversations]

export const NEEDS_ATTENTION_PAGE_SIZE = 50
export const NEEDS_ATTENTION_FEEDBACK_PAGE_SIZE = 25

export const allAttentionSourcesTerminal = (
  queriesEnabled: boolean,
  statuses: readonly string[],
) => queriesEnabled && statuses.length === 4 && statuses.every((status) => status !== 'pending')

type QualityQueryResult = {
  data?: LowQualityTurnsPage
  error: unknown
  status: string
}

type AttentionQueryResult<T> = {
  data?: T
  error: unknown
  status: string
}

type AttentionRefetchSource<T> = {
  refetch: () => Promise<AttentionQueryResult<T>>
}

type DecisionsPage = { decisions: PendingApprovalDecision[] }
type HumanOwnedPage = { conversations: ChatConversationSummary[] }
type HumanOwnedConversation = ChatConversationSummary & {
  ownership: NonNullable<ChatConversationSummary['ownership']>
}

export interface AttentionRailSnapshot {
  decisions: PendingApprovalDecision[]
  humanOwnedConversations: HumanOwnedConversation[]
}

export interface AttentionInboxSnapshot extends AttentionRailSnapshot {
  qualitySnapshot: QualityInboxSnapshot
}

const selectHumanOwned = (
  conversations: readonly ChatConversationSummary[],
): HumanOwnedConversation[] => conversations.filter(
  (conversation): conversation is HumanOwnedConversation => conversation.ownership?.state === 'human_owned',
)

const mergeAttentionRailResults = (
  previous: AttentionRailSnapshot,
  decisions: AttentionQueryResult<DecisionsPage>,
  humanOwned: AttentionQueryResult<HumanOwnedPage>,
): AttentionRailSnapshot => ({
  decisions: decisions.status === 'success' && decisions.data
    ? decisions.data.decisions
    : previous.decisions,
  humanOwnedConversations: humanOwned.status === 'success' && humanOwned.data
    ? selectHumanOwned(humanOwned.data.conversations)
    : previous.humanOwnedConversations,
})

const qualityAttempt = (query: QualityQueryResult): QualityInboxSourceAttempts['commentedFeedback'] => {
  if (query.status === 'success' && query.data) return { status: 'fulfilled', page: query.data }
  if (query.status === 'error') {
    return typeof query.error === 'object' && query.error !== null && 'status' in query.error
      && query.error.status === 403
      ? { status: 'forbidden' }
      : { status: 'failed', error: query.error }
  }
  return { status: 'skipped' }
}

/**
 * The quality sources' load state read straight off the queries. The snapshot
 * promotes on a microtask, so anything that must not act on a stale reading -
 * the smart default lens, which decides once and never reconsiders - has to
 * read the queries rather than the snapshot derived from them.
 */
export const qualityLoadStateFromQueries = (
  commentedFeedback: QualityQueryResult,
  reviewSummary: QualityQueryResult,
): { permissionDenied: boolean, hasLoadFailure: boolean } => {
  const attempts = [qualityAttempt(commentedFeedback), qualityAttempt(reviewSummary)]
  return {
    permissionDenied: attempts.some((attempt) => attempt.status === 'forbidden'),
    hasLoadFailure: attempts.some((attempt) => attempt.status === 'failed'),
  }
}

export const qualitySnapshotFromQueries = (
  previous: QualityInboxSnapshot,
  commentedFeedback: QualityQueryResult,
  reviewSummary: QualityQueryResult,
) => reduceQualityInboxSnapshot(previous, {
  commentedFeedback: qualityAttempt(commentedFeedback),
  reviewQueue: qualityAttempt(reviewSummary),
})

export const buildLatestAttentionSnapshot = (input: {
  previousQuality: QualityInboxSnapshot
  decisions?: { decisions: PendingApprovalDecision[] }
  humanOwned?: { conversations: ChatConversationSummary[] }
  commentedFeedback: QualityQueryResult
  reviewSummary: QualityQueryResult
}) => ({
  decisions: input.decisions?.decisions ?? [],
  humanOwnedConversations: selectHumanOwned(input.humanOwned?.conversations ?? []),
  qualitySnapshot: qualitySnapshotFromQueries(
    input.previousQuality,
    input.commentedFeedback,
    input.reviewSummary,
  ),
})

export const refetchAttentionRailSnapshot = async (input: {
  previous: AttentionRailSnapshot
  decisions: AttentionRefetchSource<DecisionsPage>
  humanOwned: AttentionRefetchSource<HumanOwnedPage>
}): Promise<AttentionRailSnapshot> => {
  const [decisions, humanOwned] = await Promise.all([
    input.decisions.refetch(),
    input.humanOwned.refetch(),
  ])
  return mergeAttentionRailResults(input.previous, decisions, humanOwned)
}

export const refetchAttentionInboxSnapshot = async (input: {
  previous: AttentionInboxSnapshot
  decisions: AttentionRefetchSource<DecisionsPage>
  humanOwned: AttentionRefetchSource<HumanOwnedPage>
  commentedFeedback: AttentionRefetchSource<LowQualityTurnsPage>
  reviewSummary: AttentionRefetchSource<LowQualityTurnsPage>
}): Promise<AttentionInboxSnapshot> => {
  const [decisions, humanOwned, commentedFeedback, reviewSummary] = await Promise.all([
    input.decisions.refetch(),
    input.humanOwned.refetch(),
    input.commentedFeedback.refetch(),
    input.reviewSummary.refetch(),
  ])
  return {
    ...mergeAttentionRailResults(input.previous, decisions, humanOwned),
    qualitySnapshot: qualitySnapshotFromQueries(
      input.previous.qualitySnapshot,
      commentedFeedback,
      reviewSummary,
    ),
  }
}

export const needsAttentionQualityInputs: {
  commentedFeedback: QualityTurnsRequest
  reviewSummary: QualityTurnsRequest
} = {
  commentedFeedback: {
    feedback: ['down'],
    sort: 'negative_feedback_updated_at',
    activeNegativeFeedbackOnly: true,
    hasComment: true,
    page: 1,
    pageSize: NEEDS_ATTENTION_FEEDBACK_PAGE_SIZE,
  },
  reviewSummary: {
    signal: [...QUALITY_SIGNAL_IDS],
    triageStates: ['open', 'acknowledged'],
    page: 1,
    pageSize: 1,
  },
} as const

export const useAttentionRailQueries = (workspaceId: string) => {
  const policy = useDashboardQueryPolicy()
  const decisionsKey = dashboardQueryKeys.attention.decisions(workspaceId)
  const humanOwnedKey = dashboardQueryKeys.attention.humanOwned(workspaceId, {
    pageSize: NEEDS_ATTENTION_PAGE_SIZE,
  })
  const decisions = useQuery({
    queryKey: decisionsKey,
    queryFn: ({ signal }) => hitlApi.listPendingDecisions(signal),
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(decisionsKey),
  })
  const humanOwned = useQuery({
    queryKey: humanOwnedKey,
    queryFn: ({ signal }) => chatApi.listChatHistory({
      limit: NEEDS_ATTENTION_PAGE_SIZE,
      offset: 0,
      ownership: 'human_owned',
    }, signal),
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(humanOwnedKey),
  })
  return { decisions, humanOwned, policy }
}

export const useNeedsAttentionQueries = (workspaceId: string) => {
  const attention = useAttentionRailQueries(workspaceId)
  const { policy } = attention
  const commentedFeedback = useQualityTurnsQuery(
    workspaceId,
    needsAttentionQualityInputs.commentedFeedback,
    policy.queriesEnabled,
    policy.intervalFor(dashboardQueryKeys.quality.turns(workspaceId, needsAttentionQualityInputs.commentedFeedback)),
  )
  const reviewSummary = useQualityTurnsQuery(
    workspaceId,
    needsAttentionQualityInputs.reviewSummary,
    policy.queriesEnabled,
    policy.intervalFor(dashboardQueryKeys.quality.turns(workspaceId, needsAttentionQualityInputs.reviewSummary)),
  )

  return { ...attention, commentedFeedback, reviewSummary }
}

/**
 * The open-item count behind the inbox lens toggle's "Needs you · N" label
 * (spec 1116 unification) — the same client inbox model that drives the tab
 * title in `useInboxAttentionSignal`, so the count never disagrees with what
 * the Needs-you lens's own queue shows. Uses `useAttentionRailQueries` plus
 * the one quality-turns query the model needs (commented feedback); the
 * review-summary query the full `useNeedsAttentionQueries` hook also fetches
 * is unused for a plain count, so it's left out here to avoid firing it from
 * the All lens, which otherwise has no reason to load it.
 */
export const useNeedsAttentionOpenCount = (workspaceId: string): number => {
  const attention = useAttentionRailQueries(workspaceId)
  const { policy } = attention
  const commentedFeedback = useQualityTurnsQuery(
    workspaceId,
    needsAttentionQualityInputs.commentedFeedback,
    policy.queriesEnabled,
    policy.intervalFor(dashboardQueryKeys.quality.turns(workspaceId, needsAttentionQualityInputs.commentedFeedback)),
  )

  return buildInboxModel({
    decisions: attention.decisions.data?.decisions ?? [],
    conversations: selectHumanOwned(attention.humanOwned.data?.conversations ?? []),
    qualityTurns: commentedFeedback.data?.items ?? [],
  }).items.length
}
