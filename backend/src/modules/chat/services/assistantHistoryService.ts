import type { ChatHistoryService } from "./chatHistoryService.js";

export class AssistantHistoryService {
  constructor(private readonly chatHistoryService: ChatHistoryService) {}

  listConversations(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.listConversations(workspaceId, input);
  }

  getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.getConversation(workspaceId, conversationId, input);
  }
}
