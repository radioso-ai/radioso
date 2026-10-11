import type { ChatConversationDetail, ChatConversationSummary, ConversationChannelContext, ConversationOwnership } from '@/lib/api'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { EscalationType, HandoffCandidateSource } from '@/lib/needs-attention'
import { deriveOperatorActions } from '@/lib/operator-actions'

/**
 * Pure presentation helpers for the operator inbox's response view (spec
 * 1116). Kept separate from `needs-attention.ts` (the queue/item model) so the
 * response-view-only concerns — header identity, situation text, URL display —
 * don't grow that file past the queue it already owns.
 */

// ── Visitor identity (FR-006) ───────────────────────────────────────────────

/**
 * The dashboard has no verified-customer name field to show today (no backend
 * change in this slice) — only whether the visitor session was anonymous. The
 * label is deliberately coarse rather than inventing a name.
 *
 * `anonymousSessionId` is only loaded for handoff items (see `InboxItem`); for
 * approvals and feedback it's `undefined` rather than a known verified/anonymous
 * state, so this returns a generic label instead of guessing either way.
 *
 * A session only means something on a channel that has one. An email sender has
 * no browser session, and the address they wrote from verifies nobody, so an
 * email conversation is never labeled verified (nor anonymous).
 */
export const visitorIdentityLabel = (conversation: {
  anonymousSessionId: string | null | undefined
  channel?: ConversationChannelContext['provider'] | null
}): string => {
  if (conversation.channel === 'email') {
    return 'Email sender'
  }
  if (conversation.anonymousSessionId === undefined) {
    return 'Visitor'
  }
  return conversation.anonymousSessionId === null ? 'Verified visitor' : 'Anonymous visitor'
}

// ── Entry page URL (FR-006) ─────────────────────────────────────────────────

const TRACKING_PARAM_PREFIXES = ['utm_']
const TRACKING_PARAM_NAMES = new Set(['gclid', 'fbclid', 'msclkid', 'gbraid', 'wbraid'])

const isTrackingParam = (name: string): boolean =>
  TRACKING_PARAM_NAMES.has(name.toLowerCase())
  || TRACKING_PARAM_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))

/**
 * Strips known tracking query parameters (utm_*, gclid, fbclid, ...) from a
 * visitor entry-page URL before it's shown in the response-view header. This is
 * structural query-string parsing, not product-vocabulary matching.
 */
export const stripTrackingParams = (url: string): string => {
  try {
    const parsed = new URL(url)
    for (const name of [...parsed.searchParams.keys()]) {
      if (isTrackingParam(name)) {
        parsed.searchParams.delete(name)
      }
    }
    const query = parsed.searchParams.toString()
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}${parsed.hash}`
  } catch {
    // Not a parseable absolute URL (e.g. already a bare path) — show it as-is.
    return url
  }
}

// ── Actionable/read-only source resolution (All lens) ───────────────────────

export type ReadOnlySourceDetail = Pick<
  ChatConversationDetail,
  'conversationId' | 'ownership' | 'title' | 'updatedAt' | 'agentId' | 'agentName' | 'agentInternalName'
>

/**
 * Resolves the All lens's actionable/read-only source for a selected
 * conversation. `conversationDetail` — the independently-fetched, freshest
 * ownership signal — always wins once loaded; the row's own summary
 * (`conversation`, an immediate hint with no fetch) is only used before the
 * detail has loaded. A page left open long enough for ownership to change (a
 * handoff claimed, or handed back) would otherwise keep rendering the stale
 * hint's actionable/read-only state forever. `anonymousSessionId` and
 * `preview` have no equivalent on the detail response, so those two carry
 * over from the row summary when available — they're static per-conversation
 * metadata that never goes stale the way ownership does.
 */
export const resolveReadOnlySource = (
  conversation: ChatConversationSummary | undefined,
  conversationDetail: ReadOnlySourceDetail | null,
): HandoffCandidateSource | null => {
  if (conversationDetail) {
    return {
      id: conversationDetail.conversationId,
      ownership: conversationDetail.ownership,
      title: conversationDetail.title,
      preview: conversation?.preview,
      updatedAt: conversationDetail.updatedAt,
      agentId: conversationDetail.agentId,
      agentName: conversationDetail.agentName ?? null,
      agentInternalName: conversationDetail.agentInternalName ?? null,
      anonymousSessionId: conversation?.anonymousSessionId,
    }
  }
  return conversation ?? null
}

// ── Freshest ownership (open-pane live updates) ─────────────────────────────

/**
 * The response pane reads ownership from two places while open: the
 * conversation-detail fetch (loaded once, then only refreshed after an
 * operator's own action) and the tail poll (`useConversationTail`, re-read
 * every second, and the only one of the two that observes a *transfer,
 * take-over, or hand-back made elsewhere* — Assign/Reassign or Done from
 * another tab, another teammate, the Inbox list, or Slack — while this pane
 * stays open). Both carry the conversation's ownership record whenever it
 * has one, whatever its state: a hand-back arrives as an AI-owned record
 * with a higher version, which wins over the stale human-owned one like any
 * other change. A conversation that never had a record has none on either.
 * The tail argument wins on a tied version: a poll result is never older
 * than the refetch it happened to match, so preferring it avoids ever
 * preferring a value we know is at best equally stale.
 */
export const freshestOwnership = (
  detailOwnership: ConversationOwnership | null | undefined,
  tailOwnership: ConversationOwnership | null | undefined,
): ConversationOwnership | undefined => {
  if (!detailOwnership) {
    return tailOwnership ?? undefined
  }
  if (!tailOwnership) {
    return detailOwnership
  }
  return tailOwnership.version >= detailOwnership.version ? tailOwnership : detailOwnership
}

// ── Channel label (FR-006) ──────────────────────────────────────────────────

const CHANNEL_LABELS: Partial<Record<ConversationChannelContext['provider'], string>> = {
  slack: 'Slack',
  email: 'Email',
}

/**
 * Labels the channel only when it adds information. The default web embed is
 * never labeled; a non-default channel such as Slack or email is.
 */
export const informativeChannelLabel = (
  channelContext: ConversationChannelContext | null | undefined,
): string | null => (channelContext ? CHANNEL_LABELS[channelContext.provider] ?? null : null)

// ── Situation card (FR-007) ─────────────────────────────────────────────────

export interface SituationSource {
  handoffReason: string | null
  /**
   * The stored rolling conversation summary. Always `null` today — there is no
   * summary read path wired into this surface yet — but the field exists so a
   * future summary source can replace the body without reshaping this helper
   * or its caller.
   */
  summary?: string | null
  firstVisitorMessage: string | null
}

/**
 * Selects the situation card's body text: the rolling summary when available,
 * otherwise the visitor's first message. Never blocks on summary generation —
 * a missing or expired summary silently falls back.
 */
export const selectSituationBody = (source: SituationSource): string | null =>
  source.summary ?? source.firstVisitorMessage ?? null

interface ConversationMessageLike {
  source?: string
  role: string
  content: string
}

/** The visitor's first message in the conversation, for the situation-card fallback. */
export const findFirstVisitorMessage = (
  messages: readonly ConversationMessageLike[],
): string | null =>
  messages.find((message) => message.source === 'customer' || message.role === 'user')?.content ?? null

// ── Done control (FR-010) ───────────────────────────────────────────────────

/**
 * The Done control must explain its effect at the control itself (a tooltip).
 * A handoff's Done hands the conversation back to its agent; a feedback item's
 * Done closes the triage record instead — there is no conversation to hand
 * back. Approvals never render Done (they close when the decision resolves),
 * so this is never called for them.
 */
export const doneControlTooltip = (item: {
  type: EscalationType
  agentName?: string | null
  agentInternalName?: string | null
}): string => {
  if (item.type === 'handoff') {
    const agentLabel = getAgentOperatorLabel(
      { internalName: item.agentInternalName, name: item.agentName },
      'the agent',
    )
    return `Closes this item and hands the conversation back to ${agentLabel}`
  }
  return 'Closes this item once you resolve or dismiss the feedback'
}

/**
 * Whether the Done control renders at all: only when there's something this
 * viewer can wrap up. Negative feedback never depends on ownership — closing
 * a feedback item is triage, so it shows even on a conversation a teammate
 * holds, and even before the signed-in teammate is known.
 *
 * A handoff's Done hands the conversation back, so it shows only while it is
 * human-owned and either waits unclaimed or is held by this viewer — the
 * `awaiting_human` and `owned_by_me` statuses of `deriveOperatorActions`. It
 * also shows while the detail simply hasn't loaded yet (unknown, not "no
 * ownership"; the composer alone renders meanwhile and Done stays disabled —
 * see the caller — rather than hidden, so a fast click can't mistake "not
 * loaded" for "definitely nothing to hand back"). It hides when:
 * - the signed-in teammate isn't known yet: whether the conversation is
 *   theirs to hand back can't be told, so no ownership control shows;
 * - the conversation is AI-owned, whether it never had an ownership record
 *   or its record is AI-owned again after a hand-back (possibly one made
 *   elsewhere, which the tail reports) — there is nothing to hand back, and
 *   Done appears once a send claims it again;
 * - a teammate holds it: only its owner hands it back, and the composer
 *   offers Reassign instead.
 * Approvals never render Done (they close when the decision resolves).
 */
export const shouldShowDoneControl = (
  itemType: EscalationType | undefined,
  conversationDetail: Pick<ChatConversationDetail, 'ownership'> | null,
  currentUserId: string | null,
): boolean => {
  if (itemType === 'negative_feedback') {
    return true
  }
  if (itemType !== 'handoff' || currentUserId === null) {
    return false
  }
  if (!conversationDetail) {
    return true
  }
  const { status } = deriveOperatorActions(conversationDetail.ownership, currentUserId)
  return status === 'awaiting_human' || status === 'owned_by_me'
}

// ── Read-only footer (All lens, non-actionable conversations) ──────────────

/**
 * The "handled by X" clause on the read-only footer strip (a conversation
 * selected in the All lens that isn't awaiting a human). Prefers a durable
 * human closure record when one exists (`ownership.ownerDisplayName` — not
 * populated by any read path today, but the field models the eventual
 * closure-record feature from spec 1116's FR-002), otherwise names the agent
 * that handled it. Returns `null` rather than a placeholder like "Unknown
 * agent" when nothing is actually known — the footer must never invent
 * attribution.
 */
export const readOnlyHandledByLabel = (conversation: {
  ownership?: Pick<ConversationOwnership, 'ownerDisplayName'> | null
  agentId?: string | null
  agentName?: string | null
  agentInternalName?: string | null
}): string | null => {
  const ownerName = conversation.ownership?.ownerDisplayName?.trim()
  if (ownerName) {
    return `handled by ${ownerName}`
  }
  if (!conversation.agentId) {
    return null
  }
  const agentLabel = getAgentOperatorLabel(
    { internalName: conversation.agentInternalName, name: conversation.agentName },
    'the agent',
  )
  return `handled by ${agentLabel}`
}
