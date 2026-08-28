import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";

/** Minimal chat-owned identity lookup for privileged test-turn continuation checks. */
export interface ProbeConversationReadPort {
  findProbeConversation(conversationId: string, workspaceId: string): Promise<{
    workspaceId: string;
    agentId: string | null;
    sourceChannel: string | null;
    sourceOrigin: string | null;
  } | null>;
}

export class ProbeConversationReader implements ProbeConversationReadPort {
  constructor(private readonly conversations: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">) {}

  async findProbeConversation(conversationId: string, workspaceId: string) {
    return this.conversations.findByIdAndWorkspaceId(conversationId, workspaceId);
  }
}
