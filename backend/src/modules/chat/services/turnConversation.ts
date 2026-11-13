import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";

export type TurnConversationReader = Pick<ConversationRepositoryPort, "findByIdAndAnonymousSession" | "findByIdAndWorkspaceId">;

/**
 * The conversation a turn names, as its sender may reach it: a chat session reaches only the
 * conversations it started, and a caller without one any conversation of the workspace. Null when
 * the sender cannot reach it.
 */
export const findTurnConversation = (
  conversations: TurnConversationReader,
  input: { conversationId: string; workspaceId: string; chatSessionId?: string | null },
): Promise<ConversationRecord | null> =>
  input.chatSessionId
    ? conversations.findByIdAndAnonymousSession(input.conversationId, input.workspaceId, input.chatSessionId)
    : conversations.findByIdAndWorkspaceId(input.conversationId, input.workspaceId);
