/**
 * Resolves the operator-facing dashboard link for a conversation, as an absolute URL. A port
 * rather than a helper because the dashboard's URL shape (workspace route key, section, query) is
 * host routing knowledge — a notification or a Slack post knows only that a link may exist.
 * Returns `null` when no link can be produced, for example when the workspace is gone.
 */
export interface ConversationLinkResolver {
  resolve(input: { workspaceId: string; conversationId: string }): Promise<string | null>;
}

interface ConversationLinkLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/**
 * A missing or failing link must not cost the operator the message itself: an escalation that
 * never arrives is worse than one without a link, so this degrades to `null` instead of throwing.
 */
export const resolveConversationLink = async (
  resolver: ConversationLinkResolver | undefined,
  input: { workspaceId: string; conversationId: string },
  logger?: ConversationLinkLogger,
): Promise<string | null> => {
  if (!resolver) {
    return null;
  }
  try {
    return await resolver.resolve(input);
  } catch (error) {
    logger?.warn(
      {
        event: "conversation_link_unresolved",
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      "Could not resolve the dashboard permalink for a conversation",
    );
    return null;
  }
};
