import {
  qualityApi,
  type LowQualityTurn,
  type LowQualityTurnsPage,
  type QualityActionFilter,
} from '@/lib/api'
import { ACTIVE_TRIAGE_STATES } from '@/lib/quality-signals'

export const QUALITY_INBOX_SOURCE_LIMIT = 25

type QualityInboxSourceName =
  | 'commentedFeedback'
  | 'uncommentedFeedback'
  | 'grounding'

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
  isTruncated: boolean
  status: 'ready' | 'stale' | 'failed' | 'forbidden' | 'skipped'
}

export type QualityInboxSnapshot = Record<
  QualityInboxSourceName,
  QualityInboxSourceSnapshot
>

const emptySource = (): QualityInboxSourceSnapshot => ({
  turns: [],
  isTruncated: false,
  status: 'ready',
})

export const createEmptyQualityInboxSnapshot = (): QualityInboxSnapshot => ({
  commentedFeedback: emptySource(),
  uncommentedFeedback: emptySource(),
  grounding: emptySource(),
})

const getErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined
  }
  return typeof error.status === 'number' ? error.status : undefined
}

const attempt = async (
  request: Promise<LowQualityTurnsPage>,
): Promise<QualityInboxSourceAttempt> => {
  try {
    return { status: 'fulfilled', page: await request }
  } catch (error) {
    return getErrorStatus(error) === 403
      ? { status: 'forbidden' }
      : { status: 'failed', error }
  }
}

export const loadQualityInboxSourceAttempts = async (
  groundingActions: readonly QualityActionFilter[],
): Promise<QualityInboxSourceAttempts> => {
  const activeTriageStates = [...ACTIVE_TRIAGE_STATES]
  const commentedFeedback = attempt(qualityApi.listTurns({
    feedback: ['down'],
    sort: 'negative_feedback_updated_at',
    activeNegativeFeedbackOnly: true,
    hasComment: true,
    limit: QUALITY_INBOX_SOURCE_LIMIT,
  }))
  const uncommentedFeedback = attempt(qualityApi.listTurns({
    feedback: ['down'],
    sort: 'negative_feedback_updated_at',
    activeNegativeFeedbackOnly: true,
    hasComment: false,
    limit: QUALITY_INBOX_SOURCE_LIMIT,
  }))
  const grounding = groundingActions.length > 0
    ? attempt(qualityApi.listTurns({
        actions: [...groundingActions],
        triageStates: activeTriageStates,
        limit: QUALITY_INBOX_SOURCE_LIMIT,
      }))
    : Promise.resolve<QualityInboxSourceAttempt>({ status: 'skipped' })

  const [commentedFeedbackResult, uncommentedFeedbackResult, groundingResult] =
    await Promise.all([commentedFeedback, uncommentedFeedback, grounding])

  return {
    commentedFeedback: commentedFeedbackResult,
    uncommentedFeedback: uncommentedFeedbackResult,
    grounding: groundingResult,
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
        isTruncated: next.page.total > next.page.items.length,
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
        isTruncated: false,
        status: 'forbidden',
      }
    case 'skipped':
      return {
        turns: [],
        isTruncated: false,
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
  uncommentedFeedback: reduceSource(
    previous.uncommentedFeedback,
    attempts.uncommentedFeedback,
  ),
  grounding: reduceSource(previous.grounding, attempts.grounding),
})

export interface QualityInboxPresentation {
  turns: LowQualityTurn[]
  hasLoadFailure: boolean
  permissionDenied: boolean
  isTruncated: boolean
}

export const qualityInboxPresentation = (
  snapshot: QualityInboxSnapshot,
): QualityInboxPresentation => {
  const sources = [
    snapshot.commentedFeedback,
    snapshot.uncommentedFeedback,
    snapshot.grounding,
  ]
  const turnsByMessageId = new Map<string, LowQualityTurn>()

  for (const source of sources) {
    for (const turn of source.turns) {
      if (!turnsByMessageId.has(turn.assistantMessageId)) {
        turnsByMessageId.set(turn.assistantMessageId, turn)
      }
    }
  }

  return {
    turns: [...turnsByMessageId.values()],
    hasLoadFailure: sources.some((source) =>
      source.status === 'failed' || source.status === 'stale'),
    permissionDenied: sources.some((source) => source.status === 'forbidden'),
    isTruncated: sources.some((source) => source.isTruncated),
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
    uncommentedFeedback: mapSource(snapshot.uncommentedFeedback),
    grounding: mapSource(snapshot.grounding),
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
): QualityInboxSnapshot =>
  mapSnapshotTurns(snapshot, (turn) =>
    turn.assistantMessageId === assistantMessageId ? null : turn)
