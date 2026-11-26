export interface ModelCallUsageContext {
  accountId?: string | null;
  workspaceId: string;
  agentId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  /**
   * Ray's own conversation, distinct from `conversationId`: `copilot_conversations`, not the
   * assistant's `conversations`. Only the copilot surface sets this.
   */
  copilotConversationId?: string | null;
  /** Ray's own per-turn operator message, distinct from `messageId`: `copilot_messages`, not `messages`. */
  copilotMessageId?: string | null;
  /** The document a call was made for, with the revision it read. Only document processing sets these. */
  documentId?: string | null;
  documentRevision?: number | null;
  requestId?: string | null;
  surface: string;
  operation: string;
  attemptKey: string;
}

/**
 * What a caller that replays a turn stamps on every model call the turn makes. A `null`
 * `conversationId` or `messageId` says the turn's conversation is not a stored row (a Test Chat
 * side), so the ledger insert does not name one; `requestId` then scopes the calls' idempotency
 * to one attempt, so a retried turn's calls are counted again.
 */
export type ModelCallUsageAttribution = Pick<ModelCallUsageContext, "surface" | "requestId" | "conversationId" | "messageId">;

/** Attribution for a replayed turn whose conversation and messages are not stored rows (Test Chat, Workbench replay, eval runs), scoped by the run's own id. */
export const unstoredConversationUsage = (surface: string, requestId: string): ModelCallUsageAttribution => ({
  surface, requestId, conversationId: null, messageId: null,
});
