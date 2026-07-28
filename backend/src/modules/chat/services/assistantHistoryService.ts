import type { ConversationSourceScope } from "../../../shared/domain/conversationSource.js";
import type { ConversationOwnershipScope } from "../../handoff/public.js";
import type { ChatHistoryService } from "./chatHistoryService.js";

export class AssistantHistoryService {
  constructor(private readonly chatHistoryService: ChatHistoryService) {}

  listConversations(
    workspaceId: string,
    input: {
      limit: number;
      offset?: number;
      cursor?: string;
      sourceScope?: ConversationSourceScope;
      ownership?: ConversationOwnershipScope;
    },
  ) {
    return this.chatHistoryService.listConversations(workspaceId, input);
  }

  listItems(
    workspaceId: string,
    input: { limit: number; offset?: number; sourceScope?: ConversationSourceScope },
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
    // Dashboard surface: include ownership (operator-only). The public visitor path calls
    // chatHistoryService.getConversation directly and never sets this.
    return this.chatHistoryService.getConversation(workspaceId, conversationId, input, {
      includeAnswerFeedback: true,
      includeOwnership: true,
    });
  }

  tailConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; cursor?: string },
  ) {
    return this.chatHistoryService.tailConversation(workspaceId, conversationId, input, {
      includeOwnership: true,
    });
  }

  getContactRequest(
    workspaceId: string,
    requestId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ) {
    return this.chatHistoryService.getContactRequest(workspaceId, requestId, input);
  }
}
