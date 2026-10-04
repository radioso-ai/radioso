import type {
  ChatConversationSummary,
  ConversationOwnership,
  LowQualityTurn,
  PendingApprovalDecision,
  QualityTriageRecord,
  QualityTriageState,
} from '@/lib/api'
import type { RecentlyClosedInboxItemsResponse } from '@/lib/api-types'
import type { DeliveryFailure, HeldReply } from '@/lib/api-reply-review'
import { deriveConversationOutcome } from '@/lib/conversation-outcome'
import { resolveConversationDisplayTitle } from '@/lib/conversation-title'
import { formatApprovalCreatedAt } from '@/lib/needs-attention-format'
import { buildDeliveryFailureRows, buildHeldReplyRows } from '@/lib/needs-attention-reply-review'
import { conversationOwner, type ConversationOwner } from '@/lib/operator-actions'

export type HumanOwnedConversationSummary = ChatConversationSummary & {
  ownership: ConversationOwnership
}

/**
 * The kinds of work that can land in the operator inbox. Approvals, handoffs and
 * replies that failed to reach the customer are blocking escalations a human must act
 * on (critical). Written negative feedback is explicit customer evidence that benefits
 * from a prompt operator response.
 */
export type EscalationType =
  | 'approval'
  | 'handoff'
  | 'negative_feedback'
  | 'delivery_failed'

export type EscalationSeverity = 'critical' | 'feedback'

const ESCALATION_SEVERITY: Record<EscalationType, EscalationSeverity> = {
  approval: 'critical',
  handoff: 'critical',
  negative_feedback: 'feedback',
  delivery_failed: 'critical',
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
  /**
   * Present only for approvals — the decision's own identity. Two pending
   * approvals can exist on the same conversation, so the response view must
   * match a `PendingApprovalDecision` by `agentId` + `handle`, never by
   * `conversationId` alone (see `findPendingApprovalDecision`).
   */
  handle?: string
  /**
   * Present only for an approval that is a held reply: an agent's reply waiting for an operator
   * to send, edit or discard it. Such an approval has no `handle`, and a conversation holds at
   * most one current held reply, so it is matched by conversation (see `findRefreshedInboxItem`).
   */
  heldReplyId?: string
  /**
   * Present only for delivery failures — the failure itself. One conversation can
   * hold several (one per failed reply), so a failure row is matched by this
   * failure's id, never by its conversation.
   */
  deliveryFailure?: DeliveryFailure
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
  /**
   * The conversation's last-message time, for the queue row's "last message" column.
   * Handoffs and feedback derive this from data already loaded for the inbox;
   * approvals carry no conversation-level timestamp today (see `buildInboxModel`),
   * so this stays `null` for them rather than reusing `escalatedAt` under a
   * misleading label.
   */
  lastMessageAt?: string | null
  /**
   * The teammate holding a handoff (the only item type with a human "taken by"
   * concept). `undefined` for approvals and feedback, `null` for an unclaimed
   * handoff.
   */
  takenBy?: ConversationOwner | null
  /**
   * Present only for handoffs, where the already-loaded human-owned conversation
   * summary carries it. Approvals and feedback have no loaded conversation
   * summary to source it from (`undefined`, distinct from a known-null session),
   * so the response-view header shows a generic label instead of guessing.
   */
  anonymousSessionId?: string | null
}

const byTimestampDesc = (left: string, right: string): number =>
  new Date(right).getTime() - new Date(left).getTime()

const byTimestampAsc = (left: string, right: string): number =>
  new Date(left).getTime() - new Date(right).getTime()

const feedbackActivityTimestamp = (turn: LowQualityTurn): string =>
  turn.feedback.latestDownUpdatedAt ?? turn.createdAt

type WaitingTone = 'default' | 'amber' | 'destructive'

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

interface InboxModel {
  items: InboxItem[]
}

/**
 * Merges the inbox's actionable sources into one ordered list. Critical items
 * (approvals, handoffs, delivery failures) sort above written negative feedback.
 * Critical items are oldest-first, while feedback remains newest-first.
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
  deliveryFailures?: readonly DeliveryFailure[]
  /** Held replies are approvals too, beside routine decisions. */
  heldReplies?: readonly HeldReply[]
}): InboxModel => {
  const routineApprovals: InboxItem[] = input.decisions.map((decision) => ({
    key: `approval:${decision.agentId}:${decision.handle}`,
    conversationId: decision.conversationId,
    type: 'approval',
    severity: ESCALATION_SEVERITY.approval,
    title: decision.reason ?? 'Approval requested',
    detail: decision.agentId,
    timestamp: decision.createdAt,
    escalatedAt: decision.createdAt,
    agentId: decision.agentId,
    handle: decision.handle,
    // PendingApprovalDecision carries no conversation-level last-message time.
    lastMessageAt: null,
  }))
  const heldReplyApprovals: InboxItem[] = buildHeldReplyRows(input.heldReplies ?? [], input.conversations)
    .map((row) => ({ ...row, severity: ESCALATION_SEVERITY[row.type] }))
  const approvals = [...routineApprovals, ...heldReplyApprovals]

  const handoffs: InboxItem[] = input.conversations.map(toHandoffInboxItem)

  const deliveryFailures: InboxItem[] = buildDeliveryFailureRows(input.deliveryFailures ?? [], input.conversations)
    .map((row) => ({ ...row, severity: ESCALATION_SEVERITY[row.type] }))

  const escalatedConversationIds = new Set(
    [...approvals, ...handoffs, ...deliveryFailures].map((item) => item.conversationId),
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
      // The turn's own creation time is the closest available proxy for "last
      // message" without a per-conversation timestamp on LowQualityTurn.
      lastMessageAt: turn.createdAt,
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

  const critical = [...approvals, ...handoffs, ...deliveryFailures].sort((left, right) =>
    byTimestampAsc(left.escalatedAt ?? left.timestamp, right.escalatedAt ?? right.timestamp))
  return {
    items: [...critical, ...sortedQuality.slice(0, QUALITY_INBOX_ITEM_LIMIT)],
  }
}

/**
 * The fields a handoff inbox item can be built from. `ChatConversationSummary`
 * (and `HumanOwnedConversationSummary`) satisfy this structurally, but so does
 * a conversation known only by its detail response (`ChatConversationDetail`,
 * adapted at the call site) — the response view's All-lens deep-link path
 * fetches a conversation by id independently of any loaded list page, so it
 * often has no summary to work from. `preview` and `anonymousSessionId` are
 * optional because the detail response carries neither; a missing
 * `anonymousSessionId` degrades to a generic visitor label rather than
 * guessing verified/anonymous. `title` is optional for the same defensive
 * reason, even though both concrete sources (`ChatConversationSummary` and
 * `ChatConversationDetail`) carry it; when present it wins over `preview` —
 * see `resolveConversationDisplayTitle`.
 */
export interface HandoffCandidateSource {
  id: string
  ownership?: ConversationOwnership
  title?: string | null
  preview?: string | null
  updatedAt: string
  agentId?: string | null
  agentName?: string | null
  agentInternalName?: string | null
  anonymousSessionId?: string | null
}

/**
 * Maps a conversation to its actionable ("handoff") inbox-item shape.
 * Extracted out of `buildInboxModel` so the "All" lens's response view can
 * build the same item for a conversation it selects directly (a conversation
 * row, not a queue row) and get identical actionable behavior — composer,
 * waiting-time presentation, Done semantics — without a second mapping to
 * drift from this one.
 *
 * Only a human-owned `ownership` record makes it a handoff: it carries the
 * claimed-by, waiting-since, and taken-over-at that populate the fields
 * below. A live conversation with the agent — no record yet, or an AI-owned
 * one left by a hand-back — is "in progress", not yet a handoff: those
 * fields simply stay unset rather than guessing, and the composer's own
 * claim-on-send flow (see `OperatorComposer`) is what claims it once the
 * operator sends.
 */
export const toHandoffInboxItem = (conversation: HandoffCandidateSource): InboxItem => {
  const handoff = conversation.ownership?.state === 'human_owned' ? conversation.ownership : undefined
  return {
    key: handoff ? `handoff:${conversation.id}:${handoff.version}` : `live:${conversation.id}`,
    conversationId: conversation.id,
    type: 'handoff',
    severity: ESCALATION_SEVERITY.handoff,
    title: resolveConversationDisplayTitle(conversation),
    detail: handoff ? ownershipLabel(handoff) : 'In progress',
    timestamp: conversation.updatedAt,
    escalatedAt: handoff?.updatedAt,
    takenOverAt: handoff?.takenOverAt ?? null,
    agentId: conversation.agentId,
    agentName: conversation.agentName,
    agentInternalName: conversation.agentInternalName,
    lastMessageAt: conversation.updatedAt,
    takenBy: handoff ? conversationOwner(handoff) : undefined,
    anonymousSessionId: conversation.anonymousSessionId,
  }
}

/**
 * The All lens's actionable/read-only split for a selected conversation: any
 * *live* conversation — awaiting a human, human-owned, or still in progress
 * with the agent — is actionable, with the same composer, claim-on-send, and
 * Done control as a Needs-you queue row; only a *completed* conversation is
 * read-only. Sending a reply on a live-but-unclaimed conversation claims it
 * exactly like a handoff (`OperatorComposer` already takes over before
 * sending whenever the conversation isn't already owned by a specific
 * human — see `deriveOperatorActions`). Returns `null` for read-only so the
 * response view can treat "no handoff item" as its one read-only signal.
 */
export const deriveInboxResponseHandoffItem = (
  conversation: HandoffCandidateSource,
  now: Date,
): InboxItem | null =>
  deriveConversationOutcome(conversation, now).kind === 'completed'
    ? null
    : toHandoffInboxItem(conversation)

export const buildInboxItems = (
  input: Parameters<typeof buildInboxModel>[0],
): InboxItem[] => buildInboxModel(input).items

/**
 * Matches an approval inbox item to its live `PendingApprovalDecision` by
 * identity (agentId + handle) rather than by conversation. Two pending
 * approvals can exist on one conversation (e.g. two paused routines), and
 * matching by `conversationId` alone would resolve whichever decision the
 * list happened to return first — silently applying the operator's choice to
 * the wrong decision. Returns `null` for non-approval items and for an
 * approval item with no `handle` (never expected, but a decision-less
 * approval item can't be matched to anything).
 */
export const findPendingApprovalDecision = (
  item: Pick<InboxItem, 'type' | 'agentId' | 'handle'>,
  decisions: readonly PendingApprovalDecision[],
): PendingApprovalDecision | null => {
  if (item.type !== 'approval' || !item.handle) {
    return null
  }
  return decisions.find((decision) => decision.agentId === item.agentId && decision.handle === item.handle) ?? null
}

/**
 * Finds the freshest version of a previously selected inbox item after the
 * queue refetches (waiting time, taken-by, and — for an approval — whether
 * it's still pending all live in the fresh copy). Approvals are matched by
 * identity (agentId + handle), same as `findPendingApprovalDecision` and for
 * the same reason: two pending approvals can exist on one conversation, and
 * matching by conversationId + type alone could silently swap the selected
 * approval for the conversation's other one on refetch. A delivery failure
 * is matched by its own id for the same reason: one conversation can hold a
 * failure per failed reply. A held reply is matched by its conversation, which holds one current
 * held reply at a time, so the selection follows the newer draft that replaced it and never lands
 * on a routine approval. Every other type matches by conversationId + type instead — a handoff's key embeds its
 * ownership version, which changes the moment the operator claims it, and
 * key-matching would otherwise "lose" that item on the very refetch it's
 * trying to track.
 */
export const findRefreshedInboxItem = (
  items: readonly InboxItem[],
  current: InboxItem,
): InboxItem | undefined => items.find((candidate) => {
  if (current.type === 'approval' && current.heldReplyId) {
    // A newer inbound replaces a conversation's held reply with a fresh one: follow it there.
    return candidate.type === 'approval' && candidate.heldReplyId !== undefined && candidate.conversationId === current.conversationId
  }
  if (current.type === 'approval') {
    return candidate.type === 'approval' && candidate.heldReplyId === undefined
      && candidate.agentId === current.agentId && candidate.handle === current.handle
  }
  if (current.type === 'delivery_failed') {
    return candidate.type === 'delivery_failed' && candidate.deliveryFailure?.id === current.deliveryFailure?.id
  }
  return candidate.conversationId === current.conversationId && candidate.type === current.type
})

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

interface InboxWaitingPresentation {
  label: string
  tone: WaitingTone
}

/**
 * Shared waiting-time presentation for both the queue row and the
 * response-view header, so the two surfaces never drift on what "waiting 12
 * min" versus "with them 12 min" means for a taken-over handoff.
 */
export const inboxWaitingPresentation = (item: InboxItem, now: Date): InboxWaitingPresentation => {
  if (item.severity !== 'critical') {
    return { label: formatApprovalCreatedAt(item.timestamp, now), tone: 'default' }
  }

  const isTakenOverHandoff = item.type === 'handoff' && item.takenOverAt !== null && item.takenOverAt !== undefined
  const durationStart = isTakenOverHandoff ? item.takenOverAt : item.escalatedAt
  const elapsedMs = durationStart ? Math.max(0, now.getTime() - new Date(durationStart).getTime()) : 0
  const label = `${isTakenOverHandoff ? 'with them' : 'waiting'} ${formatInboxDuration(elapsedMs)}`
  return { label, tone: isTakenOverHandoff ? 'default' : waitingTone(elapsedMs) }
}

export const ownershipLabel = (ownership: ConversationOwnership): string => {
  const owner = conversationOwner(ownership)
  if (!owner) {
    return 'Awaiting a human'
  }

  return `Handled by ${owner.label ?? 'a teammate'}`
}

// ── Queue filters (FR-017) ──────────────────────────────────────────────────

/** `'anyone' | 'unclaimed' | 'me'`, or a specific owner's user id (see `ConversationOwner`). */
export type TakenByFilter = 'anyone' | 'unclaimed' | 'me' | (string & {})

export const TAKEN_BY_ANYONE: TakenByFilter = 'anyone'
export const TAKEN_BY_UNCLAIMED: TakenByFilter = 'unclaimed'
export const TAKEN_BY_ME: TakenByFilter = 'me'

export interface InboxFilters {
  search: string
  type: EscalationType | 'all'
  agentId: 'all' | (string & {})
  takenBy: TakenByFilter
}

export const EMPTY_INBOX_FILTERS: InboxFilters = {
  search: '',
  type: 'all',
  agentId: 'all',
  takenBy: TAKEN_BY_ANYONE,
}

/**
 * Matches the operator's free-text query against an item's gist (its title).
 * Scoped to gist text only: searching full visitor transcripts would require
 * loading every unopened conversation, which this client-side model never does.
 */
export const matchesInboxSearch = (item: InboxItem, query: string): boolean => {
  const normalized = query.trim().toLowerCase()
  return normalized.length === 0 || item.title.toLowerCase().includes(normalized)
}

const matchesTakenBy = (
  item: InboxItem,
  filter: TakenByFilter,
  currentUserId: string | null,
): boolean => {
  if (filter === TAKEN_BY_ANYONE) {
    return true
  }
  // Only conversation ownership carries a "taken by" signal today (see InboxItem).
  // Approvals and feedback have no human claimant, so they match only 'anyone'.
  if (item.takenBy === undefined) {
    return false
  }
  if (filter === TAKEN_BY_UNCLAIMED) {
    return item.takenBy === null
  }
  if (item.takenBy === null) {
    return false
  }
  return item.takenBy.userId === (filter === TAKEN_BY_ME ? currentUserId : filter)
}

/** Applies the queue's search/type/agent/taken-by filters together, preserving item order. */
export const filterInboxItems = (
  items: readonly InboxItem[],
  filters: InboxFilters,
  context: { currentUserId: string | null },
): InboxItem[] => items.filter((item) =>
  (filters.type === 'all' || item.type === filters.type)
  && (filters.agentId === 'all' || item.agentId === filters.agentId)
  && matchesInboxSearch(item, filters.search)
  && matchesTakenBy(item, filters.takenBy, context.currentUserId))

/** Per-type open counts for the Type filter's option labels (e.g. "Handoffs (2)"). */
export const countInboxItemsByType = (
  items: readonly InboxItem[],
): Record<EscalationType | 'all', number> => {
  const counts: Record<EscalationType | 'all', number> = {
    all: items.length,
    approval: 0,
    handoff: 0,
    negative_feedback: 0,
    delivery_failed: 0,
  }
  for (const item of items) {
    counts[item.type] += 1
  }
  return counts
}

export interface InboxAgentOption {
  agentId: string
  agentName: string | null
  agentInternalName: string | null
}

/** Distinct agents referenced by the open queue, in first-seen order. */
export const listInboxAgents = (items: readonly InboxItem[]): InboxAgentOption[] => {
  const byId = new Map<string, InboxAgentOption>()
  for (const item of items) {
    if (!item.agentId || byId.has(item.agentId)) {
      continue
    }
    byId.set(item.agentId, {
      agentId: item.agentId,
      agentName: item.agentName ?? null,
      agentInternalName: item.agentInternalName ?? null,
    })
  }
  return [...byId.values()]
}

export interface InboxOperatorOption {
  userId: string
  label: string
}

/**
 * Distinct teammates who have taken an open item, for the "Taken by" filter's per-person options.
 * The current user is excluded — they already have their own "Me" option, so listing them again
 * by name would offer the same filter twice.
 */
export const listTakenByOperators = (
  items: readonly InboxItem[],
  currentUserId: string | null,
): InboxOperatorOption[] => {
  const byUserId = new Map<string, InboxOperatorOption>()
  for (const item of items) {
    if (!item.takenBy || item.takenBy.userId === currentUserId || byUserId.has(item.takenBy.userId)) {
      continue
    }
    byUserId.set(item.takenBy.userId, { userId: item.takenBy.userId, label: item.takenBy.label ?? 'A teammate' })
  }
  return [...byUserId.values()]
}

// ── Recently closed (FR-014 / User Story 2) ─────────────────────────────────

type ApiRecentlyClosedInboxItem = RecentlyClosedInboxItemsResponse['items'][number]

export interface RecentlyClosedInboxItem {
  key: string
  conversationId: string
  title: string
  itemKind: ApiRecentlyClosedInboxItem['itemKind']
  outcome: ApiRecentlyClosedInboxItem['outcome']
  closedAt: string
  closedBy: ApiRecentlyClosedInboxItem['closedBy']
  /** The option chosen, for an approval. */
  decisionLabel: string | null
}

export const RECENTLY_CLOSED_LIMIT = 10

/**
 * The workspace's recently closed Inbox items — handoffs handed back, approvals decided, negative
 * feedback resolved or dismissed — as the strip shows them, newest closure first as the backend
 * orders them. Each is titled like the conversation's queue row.
 */
export const buildRecentlyClosedItems = (
  items: readonly ApiRecentlyClosedInboxItem[],
): RecentlyClosedInboxItem[] => items.map((item) => ({
  key: `closed:${item.id}`,
  conversationId: item.conversationId,
  title: resolveConversationDisplayTitle(item),
  itemKind: item.itemKind,
  outcome: item.outcome,
  closedAt: item.closedAt,
  closedBy: item.closedBy,
  decisionLabel: item.decision?.label ?? null,
}))

// ── Empty-queue confidence summary (FR-014) ─────────────────────────────────

export const withinLastDays = (createdAt: string, days: number, now: Date): boolean => {
  const created = new Date(createdAt).getTime()
  return !Number.isNaN(created) && now.getTime() - created <= days * 24 * 60 * 60 * 1000
}

interface AgentHandledCount {
  agentId: string
  agentName: string | null
  agentInternalName: string | null
  count: number
}

/**
 * Counts, per agent, how many of the given conversations were never escalated to
 * a human (ownership stayed `ai_owned`, or was never claimed). Callers window the
 * input (e.g. to the last 7 days) before calling this; the model stays
 * presentation- and time-agnostic. Sorted by count descending so callers can lead
 * with the agent that handled the most on its own.
 */
export const countAiHandledConversationsByAgent = (
  conversations: readonly ChatConversationSummary[],
): AgentHandledCount[] => {
  const byAgent = new Map<string, AgentHandledCount>()
  for (const conversation of conversations) {
    if (!conversation.agentId || conversation.ownership?.state === 'human_owned') {
      continue
    }
    const existing = byAgent.get(conversation.agentId)
    if (existing) {
      existing.count += 1
    } else {
      byAgent.set(conversation.agentId, {
        agentId: conversation.agentId,
        agentName: conversation.agentName,
        agentInternalName: conversation.agentInternalName,
        count: 1,
      })
    }
  }
  return [...byAgent.values()].sort((left, right) => right.count - left.count)
}

interface AiHandledSummary {
  /** Total AI-handled conversations across every agent in the window. */
  totalCount: number
  /** Distinct agents that handled at least one — drives "agent" vs "agents" copy. */
  agentCount: number
}

/**
 * Workspace-level rollup of `countAiHandledConversationsByAgent`. The Inbox's
 * empty-state confidence line speaks for the whole workspace, not one named
 * agent — a workspace commonly runs several — so it needs the total across
 * every agent and how many distinct agents contributed, not just the top one.
 */
export const summarizeAiHandledConversations = (
  conversations: readonly ChatConversationSummary[],
): AiHandledSummary => {
  const byAgent = countAiHandledConversationsByAgent(conversations)
  return {
    totalCount: byAgent.reduce((sum, agent) => sum + agent.count, 0),
    agentCount: byAgent.length,
  }
}
