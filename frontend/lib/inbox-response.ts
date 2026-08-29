import type { ConversationChannelContext } from '@/lib/api'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { EscalationType } from '@/lib/needs-attention'

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
