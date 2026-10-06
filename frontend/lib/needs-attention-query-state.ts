'use client'

import { useCallback, useState } from 'react'
import { useInfiniteQuery, useQueries, useQuery, type InfiniteData, type UseQueryResult } from '@tanstack/react-query'

import { chatApi } from './api-chat'
import { hitlApi } from './api-hitl'
import { replyReviewApi } from './api-reply-review'
import { QUALITY_SIGNAL_IDS } from './api-quality'
import { dashboardQueryKeys } from './dashboard-query-keys'
import { isDashboardQueryRetryable, useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { useQualityTurnsQuery, type QualityTurnsRequest } from './quality-query-state'
import type { LowQualityTurnsPage } from './api-quality'
import type { ChatConversationDetail, ChatConversationSummary, PendingApprovalDecision } from './api-types'
import { resolveReadOnlySource } from './inbox-response'
import { buildInboxModel, type HandoffCandidateSource } from './needs-attention'
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
const NEEDS_ATTENTION_FEEDBACK_PAGE_SIZE = 25
/**
 * Pages one held-reply or delivery-failure read follows before it stops: 1,000 items at most. Past
 * it, "Load older" reads the next chunk on from where this one stopped.
 */
const ATTENTION_SOURCE_MAX_PAGES = 20

type CursorPage<T> = { items: T[]; nextCursor: string | null }

const uniqueById = <T extends { id: string }>(items: Iterable<T>): T[] => {
  const byId = new Map<string, T>()
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()]
}

/**
 * Every page of a newest-first cursor list from `startCursor`, followed until it ends or `maxPages`
 * were read, in the page's own shape: `nextCursor` is null when everything was read, and otherwise
 * where the unread rest starts. An item the moving list returns on two pages is kept once.
 */
export const readAllCursorPages = async <T extends { id: string }>(
  readPage: (cursor: string | null) => Promise<CursorPage<T>>,
  maxPages = ATTENTION_SOURCE_MAX_PAGES,
  startCursor: string | null = null,
): Promise<CursorPage<T>> => {
  const pages: T[][] = []
  let cursor = startCursor
  for (let pagesRead = 0; pagesRead < maxPages; pagesRead += 1) {
    const page: CursorPage<T> = await readPage(cursor)
    pages.push(page.items)
    cursor = page.nextCursor
    if (cursor === null) break
  }
  return { items: uniqueById(pages.flat()), nextCursor: cursor }
}

/** An attention source's chunks: the first read, then one more per "Load older". */
export type AttentionChunks<T> = InfiniteData<CursorPage<T>, string | null>

/** The chunks read so far as one newest-first list, each item once, and where the unread rest starts. */
export const flattenAttentionChunks = <T extends { id: string }>(chunks: AttentionChunks<T>): CursorPage<T> => ({
  items: uniqueById(chunks.pages.flatMap((chunk) => chunk.items)),
  nextCursor: chunks.pages.at(-1)?.nextCursor ?? null,
})

/** The chunks without one settled item, each chunk keeping its cursor. */
export const withoutAttentionItem = <T extends { id: string }>(
  chunks: AttentionChunks<T> | undefined,
  itemId: string,
): AttentionChunks<T> | undefined => chunks && {
  ...chunks,
  pages: chunks.pages.map((chunk) => ({ ...chunk, items: chunk.items.filter((item) => item.id !== itemId) })),
}

const nextChunkCursor = <T>(lastChunk: CursorPage<T>): string | null => lastChunk.nextCursor

const cursorQuery = (cursor: string | null) => (cursor === null ? {} : { cursor })

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

interface AttentionRailSnapshot {
  decisions: PendingApprovalDecision[]
  humanOwnedConversations: HumanOwnedConversation[]
}

interface AttentionInboxSnapshot extends AttentionRailSnapshot {
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

// A server without the delivery-failures or held-replies route answers 404: that is none, not an
// outage to retry.
const retryReplyReview = (attempt: number, error: unknown) =>
  attempt < 2
  && isDashboardQueryRetryable(error)
  && !(typeof error === 'object' && error !== null && 'status' in error && error.status === 404)

export const useAttentionRailQueries = (workspaceId: string) => {
  const policy = useDashboardQueryPolicy()
  const decisionsKey = dashboardQueryKeys.attention.decisions(workspaceId)
  const humanOwnedKey = dashboardQueryKeys.attention.humanOwned(workspaceId, {
    pageSize: NEEDS_ATTENTION_PAGE_SIZE,
  })
  const deliveryFailuresKey = dashboardQueryKeys.attention.deliveryFailures(workspaceId, {
    limit: NEEDS_ATTENTION_PAGE_SIZE,
  })
  const heldRepliesKey = dashboardQueryKeys.attention.heldReplies(workspaceId, {
    limit: NEEDS_ATTENTION_PAGE_SIZE,
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
  // Both reply-review sources read every page: they list newest first, and the queue serves the
  // oldest first, so a first page alone would hide exactly the work that has waited longest. A read
  // stops at its page limit; each "Load older" adds the next chunk, and a poll re-reads them all.
  const deliveryFailures = useInfiniteQuery({
    queryKey: deliveryFailuresKey,
    queryFn: ({ pageParam, signal }) => readAllCursorPages((cursor) =>
      replyReviewApi.listDeliveryFailures({ state: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE, ...cursorQuery(cursor) }, signal),
    ATTENTION_SOURCE_MAX_PAGES, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: nextChunkCursor,
    select: flattenAttentionChunks,
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(deliveryFailuresKey),
    retry: retryReplyReview,
  })
  const heldReplies = useInfiniteQuery({
    queryKey: heldRepliesKey,
    queryFn: ({ pageParam, signal }) => readAllCursorPages((cursor) =>
      replyReviewApi.listHeldReplies({ attention: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE, ...cursorQuery(cursor) }, signal),
    ATTENTION_SOURCE_MAX_PAGES, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: nextChunkCursor,
    select: flattenAttentionChunks,
    enabled: Boolean(workspaceId) && policy.queriesEnabled,
    refetchInterval: policy.intervalFor(heldRepliesKey),
    retry: retryReplyReview,
  })
  const { hasNextPage: olderFailures, isFetchingNextPage: loadingOlderFailures, fetchNextPage: loadOlderFailures } = deliveryFailures
  const { hasNextPage: olderHeldReplies, isFetchingNextPage: loadingOlderHeldReplies, fetchNextPage: loadOlderHeldReplies } = heldReplies
  // One control reads on in every source that stopped short of its oldest item.
  const loadOlder = useCallback(() => {
    if (olderFailures && !loadingOlderFailures) void loadOlderFailures()
    if (olderHeldReplies && !loadingOlderHeldReplies) void loadOlderHeldReplies()
  }, [loadOlderFailures, loadOlderHeldReplies, loadingOlderFailures, loadingOlderHeldReplies, olderFailures, olderHeldReplies])
  const olderAttention = {
    available: olderFailures || olderHeldReplies,
    loading: loadingOlderFailures || loadingOlderHeldReplies,
    load: loadOlder,
  }
  return { decisions, humanOwned, deliveryFailures, heldReplies, olderAttention, policy }
}

// A conversation's agent and title do not change while it waits, so a lookup is read once a while,
// never on the dashboard's poll, and a few at a time: a thousand failures must not open a thousand
// requests at once.
const CONVERSATION_SOURCE_STALE_MS = 5 * 60_000
const CONVERSATION_SOURCE_CONCURRENCY = 4

const abortError = (signal: AbortSignal | undefined): Error =>
  signal?.reason instanceof Error ? signal.reason : new DOMException('The read was cancelled.', 'AbortError')

/**
 * Runs at most `concurrency` reads at once; the rest wait their turn, in order. A read cancelled
 * while it waits never starts.
 */
export const createRequestQueue = (concurrency: number) => {
  let active = 0
  const waiting: (() => void)[] = []
  const release = () => {
    active -= 1
    waiting.shift()?.()
  }
  return <T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(start)
      if (index >= 0) waiting.splice(index, 1)
      reject(abortError(signal))
    }
    function start() {
      signal?.removeEventListener('abort', cancel)
      active += 1
      // Wrapped, so a read that throws before it returns a promise still frees its turn.
      new Promise<T>((settle) => settle(read())).then(resolve, reject).finally(release)
    }
    if (signal?.aborted) {
      cancel()
    } else if (active < concurrency) {
      start()
    } else {
      waiting.push(start)
      signal?.addEventListener('abort', cancel, { once: true })
    }
  })
}

const conversationSourceOf = (detail: ChatConversationDetail): HandoffCandidateSource | null =>
  resolveReadOnlySource(undefined, detail)

const presentSources = (
  results: UseQueryResult<HandoffCandidateSource | null>[],
): HandoffCandidateSource[] => results.flatMap((result) => (result.data ? [result.data] : []))

/**
 * The conversations named by id, each read on its own (with one message, for its title and agent),
 * for Inbox rows whose source carries no conversation facts. A conversation that cannot be read is
 * left out; its row keeps its own title and no agent.
 */
export const useConversationSources = (
  workspaceId: string,
  conversationIds: readonly string[],
): HandoffCandidateSource[] => {
  const policy = useDashboardQueryPolicy()
  const [enqueue] = useState(() => createRequestQueue(CONVERSATION_SOURCE_CONCURRENCY))
  return useQueries({
    queries: conversationIds.map((conversationId) => ({
      queryKey: dashboardQueryKeys.attention.conversationSource(workspaceId, conversationId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        enqueue(() => chatApi.getHistoryConversation(conversationId, { limit: 1 }, signal), signal),
      select: conversationSourceOf,
      enabled: Boolean(workspaceId) && policy.queriesEnabled,
      staleTime: CONVERSATION_SOURCE_STALE_MS,
      refetchInterval: false as const,
    })),
    combine: presentSources,
  })
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
 * the Needs-you lens's own queue shows. Uses `useAttentionRailQueries`
 * (approvals and held replies, handoffs, delivery failures) plus
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
    deliveryFailures: attention.deliveryFailures.data?.items ?? [],
    heldReplies: attention.heldReplies.data?.items ?? [],
  }).items.length
}
