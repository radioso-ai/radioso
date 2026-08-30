import type { ConversationSourceScope } from "../../../shared/domain/conversationSource.js";
import type { ConversationOutcomeFilter } from "../../../shared/domain/conversationOutcome.js";
import type { ConversationOwnershipScope } from "../../handoff/public.js";
import type { ChatHistoryService } from "./chatHistoryService.js";

const dashboardConversationDetailOptions = {
  includeAnswerFeedback: true,
  includeOwnership: true,
  includeAgentInternalName: true,
  includeTurnFailureDebug: true,
};

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
    input: {
      limit: number;
      offset?: number;
      sourceScope?: ConversationSourceScope;
      q?: string;
      agentId?: string;
      sourceOrigin?: string;
      outcome?: ConversationOutcomeFilter;
    },
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
    // Dashboard surface: include operator-only ownership and agent details. The public visitor
    // path calls chatHistoryService.getConversation directly and never sets these.
    return this.chatHistoryService.getConversation(workspaceId, conversationId, input, dashboardConversationDetailOptions);
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
    return this.chatHistoryService.getContactRequest(workspaceId, requestId, input, dashboardConversationDetailOptions);
  }
}
