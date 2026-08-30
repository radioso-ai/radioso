import type { ChatConversationDetail, ChatConversationSummary, ConversationChannelContext, ConversationOwnership } from '@/lib/api'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { EscalationType, HandoffCandidateSource } from '@/lib/needs-attention'

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
 */
export const visitorIdentityLabel = (conversation: { anonymousSessionId: string | null | undefined }): string => {
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

// ── Channel label (FR-006) ──────────────────────────────────────────────────

/**
 * Labels the channel only when it adds information. The default web embed is
 * never labeled; a non-default channel such as Slack is.
 */
export const informativeChannelLabel = (
  channelContext: ConversationChannelContext | null | undefined,
): string | null => channelContext?.provider === 'slack' ? 'Slack' : null

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

export interface ConversationMessageLike {
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
 * Whether the Done control renders at all: only when there's something to
 * wrap up. A handoff needs an ownership record — the only state the wire
 * ever sends non-null `ownership` for, covering both "awaiting a human"
 * (unclaimed) and "human-owned" (claimed) — or the detail simply hasn't
 * loaded yet (unknown, not "no ownership"; the composer alone renders
 * meanwhile and Done stays disabled — see the caller — rather than hidden,
 * so a fast click can't mistake "not loaded" for "definitely nothing to hand
 * back"). Negative feedback never depends on ownership. A live AI-owned
 * conversation with a *loaded* detail showing no ownership record has
 * nothing to hand back — the composer alone is correct there; Done appears
 * once the first send claims it and the detail refetch brings the record.
 * Approvals never render Done (they close when the decision resolves).
 */
export const shouldShowDoneControl = (
  itemType: EscalationType | undefined,
  conversationDetail: { ownership?: unknown } | null,
): boolean => {
  if (itemType === 'negative_feedback') {
    return true
  }
  if (itemType !== 'handoff') {
    return false
  }
  return !conversationDetail || Boolean(conversationDetail.ownership)
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
