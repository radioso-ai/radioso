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

export type ModelCallUsageAttribution = Pick<ModelCallUsageContext, "surface" | "requestId">;
