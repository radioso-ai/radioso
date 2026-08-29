import type { ChatConversationSummary } from '@/lib/api'

/**
 * The operator-facing outcome shown on the Conversations list (spec 1116).
 * A conversation reads as handed off, in progress, or completed — the
 * feedback and routine-completion outcomes from the design mockup need
 * signals `ChatConversationSummary` doesn't carry today, so they're
 * intentionally not modeled here.
 */
export type ConversationOutcome =
  | { kind: 'handed_off' }
  | { kind: 'in_progress' }
  | { kind: 'completed' }

/** A conversation with no human ownership counts as "in progress" within this window of its last activity. */
export const IN_PROGRESS_WINDOW_MS = 10 * 60 * 1000

/**
 * Priority order: an `ownership` record (present only for human-owned
 * conversations — the list endpoint omits it entirely for AI-owned rows)
 * always wins over recency, since a conversation someone claimed a moment
 * ago is handed off, not "in progress." Otherwise recency decides.
 *
 * `now` is an explicit parameter rather than read from `Date.now()` so the
 * boundary is deterministically testable.
 */
export function deriveConversationOutcome(
  conversation: Pick<ChatConversationSummary, 'ownership' | 'updatedAt'>,
  now: Date,
): ConversationOutcome {
  if (conversation.ownership) {
    return { kind: 'handed_off' }
  }

  const elapsedMs = now.getTime() - new Date(conversation.updatedAt).getTime()
  if (elapsedMs <= IN_PROGRESS_WINDOW_MS) {
    return { kind: 'in_progress' }
  }

  return { kind: 'completed' }
}
