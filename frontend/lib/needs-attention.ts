import type {
  ChatConversationSummary,
  ConversationOwnership,
  LowQualityTurn,
  PendingApprovalDecision,
  QualityTriageRecord,
  QualityTriageState,
} from '@/lib/api'

export type HumanOwnedConversationSummary = ChatConversationSummary & {
  ownership: ConversationOwnership
}

/**
 * The kinds of work that can land in the operator inbox. Approvals and handoffs are
 * blocking escalations a human must act on (critical). Written negative feedback is
 * explicit customer evidence that benefits from a prompt operator response.
 */
export type EscalationType =
  | 'approval'
  | 'handoff'
  | 'negative_feedback'

export type EscalationSeverity = 'critical' | 'feedback'

export const ESCALATION_SEVERITY: Record<EscalationType, EscalationSeverity> = {
  approval: 'critical',
  handoff: 'critical',
  negative_feedback: 'feedback',
}

/** A unified, categorized inbox row independent of which source produced it. */
export interface InboxItem {
  key: string
  conversationId: string
  type: EscalationType
  severity: EscalationSeverity
  /** Primary label: the approval reason, conversation preview, or the user's question. */
  title: string
  /** Secondary descriptor: the agent, or the human owner for a handoff. */
  detail: string
  timestamp: string
  /** When the operator-facing escalation began; present for critical rows only. */
  escalatedAt?: string
  /** Present for handoffs; distinguishes an unassigned wait from an active takeover. */
  takenOverAt?: string | null
  /** Present only for quality signals — the turn to triage so the row can be cleared. */
  assistantMessageId?: string
  /** Quality evidence used by the negative-feedback review accessory. */
  answerPreview?: string
  feedbackComment?: string | null
  feedbackDownCount?: number
  feedbackUpdatedAt?: string | null
  triageState?: QualityTriageState
  triage?: QualityTriageRecord
  agentId?: string | null
  agentName?: string | null
  agentInternalName?: string | null
}

const byTimestampDesc = (left: string, right: string): number =>
  new Date(right).getTime() - new Date(left).getTime()

const byTimestampAsc = (left: string, right: string): number =>
  new Date(left).getTime() - new Date(right).getTime()

const feedbackActivityTimestamp = (turn: LowQualityTurn): string =>
  turn.feedback.latestDownUpdatedAt ?? turn.createdAt

export type WaitingTone = 'default' | 'amber' | 'destructive'

export const formatInboxDuration = (elapsedMs: number): string => {
  const totalMinutes = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 60_000)) : 0
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) {
    return `${minutes} min`
  }

  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

export const waitingTone = (elapsedMs: number): WaitingTone => {
  if (elapsedMs >= 60 * 60_000) {
    return 'destructive'
  }
  if (elapsedMs >= 15 * 60_000) {
    return 'amber'
  }
  return 'default'
}

const latestDownComment = (turn: LowQualityTurn) =>
  turn.feedback.comments
    .filter((entry) => entry.value === 'down')
    .sort((left, right) => byTimestampDesc(left.updatedAt, right.updatedAt))[0] ?? null

const shouldReplaceQualityTurn = (
  existing: LowQualityTurn,
  candidate: LowQualityTurn,
): boolean =>
  byTimestampDesc(
    feedbackActivityTimestamp(candidate),
    feedbackActivityTimestamp(existing),
  ) < 0

export const QUALITY_INBOX_ITEM_LIMIT = 25

export interface InboxModel {
  items: InboxItem[]
}

/**
 * Merges the inbox's actionable sources into one ordered list. Critical items
 * (approvals, handoffs) sort above written negative feedback. Critical items are
 * oldest-first, while feedback remains newest-first.
 *
 * Dedup is by conversation, critical wins: feedback on a conversation that is already
 * escalated is dropped so it isn't shown twice. Multiple written-feedback turns in one
 * conversation collapse to the one with the freshest feedback activity.
 *
 * The model rejects passive quality signals defensively. The loader already supplies
 * only commented feedback, but this boundary keeps a future caller from turning every
 * automated signal into operator work again.
 */
export const buildInboxModel = (input: {
  decisions: PendingApprovalDecision[]
  conversations: HumanOwnedConversationSummary[]
  qualityTurns: LowQualityTurn[]
}): InboxModel => {
  const approvals: InboxItem[] = input.decisions.map((decision) => ({
    key: `approval:${decision.agentId}:${decision.handle}`,
    conversationId: decision.conversationId,
    type: 'approval',
    severity: ESCALATION_SEVERITY.approval,
    title: decision.reason ?? 'Approval requested',
    detail: decision.agentId,
    timestamp: decision.createdAt,
    escalatedAt: decision.createdAt,
  }))

  const handoffs: InboxItem[] = input.conversations.map((conversation) => ({
    key: `handoff:${conversation.id}:${conversation.ownership.version}`,
    conversationId: conversation.id,
    type: 'handoff',
    severity: ESCALATION_SEVERITY.handoff,
    title: conversation.preview || 'Untitled conversation',
    detail: ownershipLabel(conversation.ownership),
    timestamp: conversation.updatedAt,
    escalatedAt: conversation.ownership.updatedAt,
    takenOverAt: conversation.ownership.takenOverAt,
  }))

  const escalatedConversationIds = new Set(
    [...approvals, ...handoffs].map((item) => item.conversationId),
  )

  const selectedQualityByConversation = new Map<string, LowQualityTurn>()
  for (const turn of input.qualityTurns) {
    if (
      escalatedConversationIds.has(turn.conversationId)
      || latestDownComment(turn) === null
    ) {
      continue
    }
    const existing = selectedQualityByConversation.get(turn.conversationId)
    if (!existing || shouldReplaceQualityTurn(existing, turn)) {
      selectedQualityByConversation.set(turn.conversationId, turn)
    }
  }

  const quality: InboxItem[] = [...selectedQualityByConversation.values()].flatMap((turn) => {
    const feedbackComment = latestDownComment(turn)
    return feedbackComment ? [{
      key: `quality:${turn.assistantMessageId}`,
      conversationId: turn.conversationId,
      type: 'negative_feedback',
      severity: ESCALATION_SEVERITY.negative_feedback,
      title: turn.question || 'Low-quality answer',
      detail: feedbackComment.comment,
      timestamp: feedbackActivityTimestamp(turn),
      assistantMessageId: turn.assistantMessageId,
      answerPreview: turn.answerPreview,
      feedbackComment: feedbackComment.comment,
      feedbackDownCount: turn.feedback.downCount,
      feedbackUpdatedAt: turn.feedback.latestDownUpdatedAt,
      triageState: turn.triage.state,
      triage: turn.triage,
      agentId: turn.agentId,
      agentName: turn.agentName,
      agentInternalName: turn.agentInternalName,
    }] : []
  })

  const sortedQuality = quality.sort((left, right) =>
    byTimestampDesc(left.timestamp, right.timestamp))

  const critical = [...approvals, ...handoffs].sort((left, right) =>
    byTimestampAsc(left.escalatedAt ?? left.timestamp, right.escalatedAt ?? right.timestamp))
  return {
    items: [...critical, ...sortedQuality.slice(0, QUALITY_INBOX_ITEM_LIMIT)],
  }
}

export const buildInboxItems = (
  input: Parameters<typeof buildInboxModel>[0],
): InboxItem[] => buildInboxModel(input).items

/** Page size used when loading the human-owned conversations shown in the inbox. */
export const HUMAN_OWNED_CONVERSATION_PAGE_SIZE = 50

export const selectHumanOwnedConversations = (
  summaries: ChatConversationSummary[],
): HumanOwnedConversationSummary[] =>
  summaries.filter(
    (summary): summary is HumanOwnedConversationSummary => summary.ownership?.state === 'human_owned',
  )

/**
 * Builds an order-independent key per inbox item. The indicator poll diffs the latest keys against
 * the displayed state to detect new activity: a key changes when an approval is created, or a
 * human-owned conversation gains a message or changes ownership. Quality keys are limited to the
 * rows the inbox would display, so a quality signal represented by a critical escalation does not
 * create false new activity. Keys capture only identity + freshness markers (never payloads), and
 * approval vs conversation keys are namespaced so they can't collide.
 */
export const inboxItemKeys = (
  decisions: PendingApprovalDecision[],
  conversations: HumanOwnedConversationSummary[],
  qualityTurns: LowQualityTurn[],
): string[] => {
  const approvalKeys = decisions.map((decision) => `approval:${decision.agentId}:${decision.handle}`)
  const conversationKeys = conversations.map(
    (conversation) => `conversation:${conversation.id}:${conversation.updatedAt}:${conversation.ownership.version}`,
  )

  const qualityKeys = buildInboxItems({ decisions, conversations, qualityTurns })
    .filter((item) => item.assistantMessageId)
    .map((item) => item.type === 'negative_feedback'
      ? `quality:${item.assistantMessageId}:down:${item.feedbackDownCount ?? 0}:comment:${item.feedbackUpdatedAt ?? 'none'}`
      : `quality:${item.assistantMessageId}`)

  return [...approvalKeys, ...conversationKeys, ...qualityKeys].sort()
}

/**
 * Counts how many of the latest inbox keys are not present in the operator's displayed state — i.e.
 * the number of newly-arrived or freshly-updated items since the last refresh. Removals (an approval
 * resolved elsewhere, a conversation handed back to the AI) are not counted as new activity.
 */
export const countNewInboxItems = (
  baselineKeys: readonly string[],
  latestKeys: readonly string[],
): number => {
  const baseline = new Set(baselineKeys)
  let count = 0
  for (const key of latestKeys) {
    if (!baseline.has(key)) {
      count += 1
    }
  }
  return count
}

export const ownershipLabel = (ownership: ConversationOwnership): string => {
  if (ownership.ownerAccountId === null) {
    return 'Awaiting a human'
  }

  return `Handled by ${ownership.ownerDisplayName?.trim() || 'a teammate'}`
}
