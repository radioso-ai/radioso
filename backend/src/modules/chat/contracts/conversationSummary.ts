/**
 * The rolling per-conversation summary (#866). One record per conversation,
 * regenerated off the critical path after a turn completes and injected alongside
 * the fixed recent-message window into turn interpretation and answer composition.
 */
export interface ConversationSummaryRecord {
  /** Bounded summary text, written in the conversation's own language. */
  summary: string;
  /**
   * Total message count the summary was generated from. Used as a monotonic
   * watermark so an older in-flight regeneration cannot clobber a newer one.
   */
  coveredMessageCount: number;
  /** Timestamp of the newest message the summary covers. */
  coveredThrough: Date;
}

/**
 * Narrow persistence port for {@link ConversationSummaryRecord}, owned by the chat
 * module and implemented by the DB repository. `load` returns null for a missing
 * or expired row; `save` is watermark-guarded (see the repository).
 */
export interface ConversationSummaryStore {
  load(input: { sessionId: string }): Promise<ConversationSummaryRecord | null>;
  save(input: { sessionId: string; summary: ConversationSummaryRecord }): Promise<void>;
}

/**
 * Best-effort read of the summary text for prompt injection, shared by session
 * preparation and the approval-resume path so the "no summary" policy (blank ⇒
 * absent, read failure ⇒ absent) cannot drift between them. A failure degrades
 * to no summary — the turn always proceeds on the recent-message window alone —
 * but is logged (content-free) so a broken read path is visible to operators.
 */
export const loadConversationSummaryText = async (
  store: Pick<ConversationSummaryStore, "load"> | undefined,
  conversationId: string,
  logger?: { warn: (obj: object, msg?: string) => void },
): Promise<string | undefined> => {
  if (!store) {
    return undefined;
  }
  try {
    const record = await store.load({ sessionId: conversationId });
    const summary = record?.summary.trim();
    return summary ? summary : undefined;
  } catch (error) {
    logger?.warn(
      {
        event: "conversation_summary_load_failed",
        conversationId,
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : undefined,
      },
      "Failed to load conversation summary; continuing without it",
    );
    return undefined;
  }
};
