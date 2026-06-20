import type { ChatConversationSummary, ConversationOwnership, LowQualityTurn, PendingApprovalDecision } from '@/lib/api'

export type HumanOwnedConversationSummary = ChatConversationSummary & {
  ownership: ConversationOwnership
}

/**
 * The kinds of work that can land in the operator inbox. Approvals and handoffs are
 * blocking escalations a human must act on (critical). Degraded and no-context answers
 * are quality signals the AI already handled but that an operator may want to review
 * (lower concern). The type is derived on the client from each source's existing data.
 */
export type EscalationType = 'approval' | 'handoff' | 'degraded' | 'no_context'

export type EscalationSeverity = 'critical' | 'lower'

export const ESCALATION_SEVERITY: Record<EscalationType, EscalationSeverity> = {
  approval: 'critical',
  handoff: 'critical',
  degraded: 'lower',
  no_context: 'lower',
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
  /** Present only for quality signals — the turn to triage so the row can be cleared. */
  assistantMessageId?: string
}

/** Maps a grounding-gap skill outcome to its escalation type (enum values, not prose). */
const qualityEscalationType = (skillOutcome: string | null): EscalationType =>
  skillOutcome === 'no_context' ? 'no_context' : 'degraded'

const severityRank: Record<EscalationSeverity, number> = { critical: 0, lower: 1 }

const byTimestampDesc = (left: string, right: string): number =>
  new Date(right).getTime() - new Date(left).getTime()

/**
 * Merges the inbox's three sources into one severity-ordered list. Critical items
 * (approvals, handoffs) sort above lower-concern quality signals; within a severity
 * the newest is first.
 *
 * Dedup is by conversation, critical wins: a quality gap whose conversation is already
 * escalated (e.g. a no-context that triggered a handoff) is dropped so it isn't shown
 * twice and the escalated-vs-not distinction stays honest. Multiple low-quality turns in
 * one conversation collapse to its most recent, keeping the inbox conversation-scoped.
 */
export const buildInboxItems = (input: {
  decisions: PendingApprovalDecision[]
  conversations: HumanOwnedConversationSummary[]
  qualityTurns: LowQualityTurn[]
}): InboxItem[] => {
  const approvals: InboxItem[] = input.decisions.map((decision) => ({
    key: `approval:${decision.agentId}:${decision.handle}`,
    conversationId: decision.conversationId,
    type: 'approval',
    severity: ESCALATION_SEVERITY.approval,
    title: decision.reason ?? 'Approval requested',
    detail: decision.agentId,
    timestamp: decision.createdAt,
  }))

  const handoffs: InboxItem[] = input.conversations.map((conversation) => ({
    key: `handoff:${conversation.id}:${conversation.ownership.version}`,
    conversationId: conversation.id,
    type: 'handoff',
    severity: ESCALATION_SEVERITY.handoff,
    title: conversation.preview || 'Untitled conversation',
    detail: ownershipLabel(conversation.ownership),
    timestamp: conversation.updatedAt,
  }))

  const escalatedConversationIds = new Set(
    [...approvals, ...handoffs].map((item) => item.conversationId),
  )

  const latestQualityByConversation = new Map<string, LowQualityTurn>()
  for (const turn of input.qualityTurns) {
    if (escalatedConversationIds.has(turn.conversationId)) {
      continue
    }
    const existing = latestQualityByConversation.get(turn.conversationId)
    if (!existing || byTimestampDesc(turn.createdAt, existing.createdAt) < 0) {
      latestQualityByConversation.set(turn.conversationId, turn)
    }
  }

  const quality: InboxItem[] = [...latestQualityByConversation.values()].map((turn) => {
    const type = qualityEscalationType(turn.skillOutcome)
    return {
      key: `quality:${turn.assistantMessageId}`,
      conversationId: turn.conversationId,
      type,
      severity: ESCALATION_SEVERITY[type],
      title: turn.question || 'Low-quality answer',
      detail: turn.agentName ?? '',
      timestamp: turn.createdAt,
      assistantMessageId: turn.assistantMessageId,
    }
  })

  return [...approvals, ...handoffs, ...quality].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      byTimestampDesc(left.timestamp, right.timestamp),
  )
}

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
 * human-owned conversation gains a message or changes ownership. Keys capture only identity +
 * freshness markers (never payloads), and approval vs conversation keys are namespaced so they
 * can't collide.
 */
export const inboxItemKeys = (
  decisions: PendingApprovalDecision[],
  conversations: HumanOwnedConversationSummary[],
): string[] => {
  const approvalKeys = decisions.map((decision) => `approval:${decision.agentId}:${decision.handle}`)
  const conversationKeys = conversations.map(
    (conversation) => `conversation:${conversation.id}:${conversation.updatedAt}:${conversation.ownership.version}`,
  )

  return [...approvalKeys, ...conversationKeys].sort()
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
