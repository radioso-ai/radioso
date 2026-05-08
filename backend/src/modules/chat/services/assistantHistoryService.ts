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

  listContacts(
    workspaceId: string,
    input: { limit: number; offset?: number },
  ) {
    return this.chatHistoryService.listContacts(workspaceId, input);
  }

  getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.getConversation(workspaceId, conversationId, input, { includeAnswerFeedback: true });
  }

  getContactRequest(
    workspaceId: string,
    requestId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.getContactRequest(workspaceId, requestId, input);
  }
}
