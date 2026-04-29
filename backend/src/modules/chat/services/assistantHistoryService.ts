import type { ChatHistoryService } from "./chatHistoryService.js";

export class AssistantHistoryService {
  constructor(private readonly chatHistoryService: ChatHistoryService) {}

  listConversations(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.listConversations(workspaceId, input);
  }

  listItems(
    workspaceId: string,
    input: { limit: number; offset?: number },
  ) {
    return this.chatHistoryService.listItems(workspaceId, input);
  }

  getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.getConversation(workspaceId, conversationId, input);
  }
}
