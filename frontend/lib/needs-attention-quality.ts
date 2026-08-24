import {
  QUALITY_SIGNAL_IDS,
  qualityApi,
  type LowQualityTurn,
  type LowQualityTurnsPage,
} from '@/lib/api'
import { ACTIVE_TRIAGE_STATES } from '@/lib/quality-signals'

export const QUALITY_INBOX_SOURCE_LIMIT = 25

type QualityInboxSourceName =
  | 'commentedFeedback'
  | 'reviewQueue'

type QualityInboxSourceAttempt =
  | { status: 'fulfilled'; page: LowQualityTurnsPage }
  | { status: 'failed'; error: unknown }
  | { status: 'forbidden' }
  | { status: 'skipped' }

export type QualityInboxSourceAttempts = Record<
  QualityInboxSourceName,
  QualityInboxSourceAttempt
>

interface QualityInboxSourceSnapshot {
  turns: LowQualityTurn[]
  total: number
  status: 'ready' | 'stale' | 'failed' | 'forbidden' | 'skipped'
}

export type QualityInboxSnapshot = Record<
  QualityInboxSourceName,
  QualityInboxSourceSnapshot
>

const emptySource = (): QualityInboxSourceSnapshot => ({
  turns: [],
  total: 0,
  status: 'ready',
})

export const createEmptyQualityInboxSnapshot = (): QualityInboxSnapshot => ({
  commentedFeedback: emptySource(),
  reviewQueue: emptySource(),
})

const getErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined
  }
  return typeof error.status === 'number' ? error.status : undefined
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

const attempt = async (
  request: Promise<LowQualityTurnsPage>,
): Promise<QualityInboxSourceAttempt> => {
  try {
    return { status: 'fulfilled', page: await request }
  } catch (error) {
    if (isAbortError(error)) throw error
    return getErrorStatus(error) === 403
      ? { status: 'forbidden' }
      : { status: 'failed', error }
  }
}

export const loadQualityInboxSourceAttempts = async (
  options: { includeReviewSummary?: boolean } = {},
  signal?: AbortSignal,
): Promise<QualityInboxSourceAttempts> => {
  const activeTriageStates = [...ACTIVE_TRIAGE_STATES]
  const listTurns = (input: Parameters<typeof qualityApi.listTurns>[0]) =>
    signal === undefined ? qualityApi.listTurns(input) : qualityApi.listTurns(input, signal)
  const commentedFeedback = attempt(listTurns({
    feedback: ['down'],
    sort: 'negative_feedback_updated_at',
    activeNegativeFeedbackOnly: true,
    hasComment: true,
    limit: QUALITY_INBOX_SOURCE_LIMIT,
  }))
  const reviewQueue: Promise<QualityInboxSourceAttempt> =
    options.includeReviewSummary === false
      ? Promise.resolve({ status: 'skipped' })
      : attempt(listTurns({
          signal: [...QUALITY_SIGNAL_IDS],
          triageStates: activeTriageStates,
          limit: 1,
        }))

  const [commentedFeedbackResult, reviewQueueResult] =
    await Promise.all([commentedFeedback, reviewQueue])

  return {
    commentedFeedback: commentedFeedbackResult,
    reviewQueue: reviewQueueResult,
  }
}

const reduceSource = (
  previous: QualityInboxSourceSnapshot,
  next: QualityInboxSourceAttempt,
): QualityInboxSourceSnapshot => {
  switch (next.status) {
    case 'fulfilled':
      return {
        turns: next.page.items,
        total: next.page.total,
        status: 'ready',
      }
    case 'failed':
      return {
        ...previous,
        status: previous.turns.length > 0 ? 'stale' : 'failed',
      }
    case 'forbidden':
      return {
        turns: [],
        total: 0,
        status: 'forbidden',
      }
    case 'skipped':
      return {
        turns: [],
        total: 0,
        status: 'skipped',
      }
  }
}

export const reduceQualityInboxSnapshot = (
  previous: QualityInboxSnapshot,
  attempts: QualityInboxSourceAttempts,
): QualityInboxSnapshot => ({
  commentedFeedback: reduceSource(
    previous.commentedFeedback,
    attempts.commentedFeedback,
  ),
  reviewQueue: reduceSource(previous.reviewQueue, attempts.reviewQueue),
})

export interface QualityInboxPresentation {
  turns: LowQualityTurn[]
  reviewCount: number | null
  commentedFeedbackCount: number | null
  hasLoadFailure: boolean
  permissionDenied: boolean
}

export const qualityInboxPresentation = (
  snapshot: QualityInboxSnapshot,
): QualityInboxPresentation => {
  const sources = [
    snapshot.commentedFeedback,
    snapshot.reviewQueue,
  ]
  const availableTotal = (source: QualityInboxSourceSnapshot): number | null =>
    source.status === 'failed' || source.status === 'forbidden' || source.status === 'skipped'
      ? null
      : source.total

  return {
    turns: snapshot.commentedFeedback.turns,
    reviewCount: availableTotal(snapshot.reviewQueue),
    commentedFeedbackCount: availableTotal(snapshot.commentedFeedback),
    hasLoadFailure: sources.some((source) =>
      source.status === 'failed' || source.status === 'stale'),
    permissionDenied: sources.some((source) => source.status === 'forbidden'),
  }
}

const mapSnapshotTurns = (
  snapshot: QualityInboxSnapshot,
  mapTurn: (turn: LowQualityTurn) => LowQualityTurn | null,
): QualityInboxSnapshot => {
  const mapSource = (
    source: QualityInboxSourceSnapshot,
  ): QualityInboxSourceSnapshot => ({
    ...source,
    turns: source.turns.flatMap((turn) => {
      const next = mapTurn(turn)
      return next ? [next] : []
    }),
  })

  return {
    commentedFeedback: mapSource(snapshot.commentedFeedback),
    reviewQueue: mapSource(snapshot.reviewQueue),
  }
}

export const updateQualityInboxTurn = (
  snapshot: QualityInboxSnapshot,
  assistantMessageId: string,
  update: (turn: LowQualityTurn) => LowQualityTurn,
): QualityInboxSnapshot =>
  mapSnapshotTurns(snapshot, (turn) =>
    turn.assistantMessageId === assistantMessageId ? update(turn) : turn)

export const removeQualityInboxTurn = (
  snapshot: QualityInboxSnapshot,
  assistantMessageId: string,
): QualityInboxSnapshot => {
  const removeFromSource = (
    source: QualityInboxSourceSnapshot,
  ): QualityInboxSourceSnapshot => ({
    ...source,
    turns: source.turns.filter((turn) => turn.assistantMessageId !== assistantMessageId),
    total: Math.max(0, source.total - 1),
  })

  return {
    commentedFeedback: removeFromSource(snapshot.commentedFeedback),
    // Every written down-vote is one member of the all-signal active queue, even
    // when the one-row aggregate sample happens to contain a different answer.
    reviewQueue: removeFromSource(snapshot.reviewQueue),
  }
}
