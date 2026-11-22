import type { ConversationSourceScope } from "../../../shared/domain/conversationSource.js";
import type { ConversationActivityReadScope } from "../../conversationActivity/contracts/index.js";
import type { ConversationAttributeFilterInput } from "../../context-variables/public.js";
import type { ConversationOwnershipScope } from "../../handoff/public.js";
import type { HistoryItemsFilters } from "../../../db/repositories/historyItemsRepository.js";
import type { ChatHistoryService } from "./chatHistoryService.js";

// The activity a caller may see depends on its permissions, so each read passes its own scope.
const dashboardConversationDetailOptions = (activity: ConversationActivityReadScope) => ({
  includeAnswerFeedback: true,
  includeOwnership: true,
  includeAgentInternalName: true,
  includeTurnFailureDebug: true,
  includeOperatorLabel: true,
  activity,
});

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
      agentId?: string;
      channel?: string;
      attribute?: ConversationAttributeFilterInput;
    },
  ) {
    return this.chatHistoryService.listConversations(workspaceId, input);
  }

  listItems(
    workspaceId: string,
    input: { limit: number; offset?: number; sourceScope?: ConversationSourceScope; attribute?: ConversationAttributeFilterInput }
      & Omit<HistoryItemsFilters, "attribute">,
  ) {
    return this.chatHistoryService.listItems(workspaceId, input);
  }

  listContacts(
    workspaceId: string,
    input: { limit: number; offset?: number },
  ) {
    return this.chatHistoryService.listContacts(workspaceId, input);
  }

  listVisitorConversations(
    workspaceId: string,
    visitorId: string,
    input: { limit: number; offset?: number; cursor?: string; exclude?: string },
  ) {
    return this.chatHistoryService.listVisitorConversations(workspaceId, visitorId, input);
  }

  getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
    activity: ConversationActivityReadScope,
  ) {
    // Dashboard surface: include operator-only ownership and agent details, and the conversation's
    // attributes. The public visitor path calls chatHistoryService.getConversation directly and
    // never sets these.
    return this.chatHistoryService.getConversation(workspaceId, conversationId, input, {
      ...dashboardConversationDetailOptions(activity),
      includeAttributes: true,
    });
  }

  tailConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; cursor?: string; activityCursor?: string },
    activity: ConversationActivityReadScope,
  ) {
    return this.chatHistoryService.tailConversation(workspaceId, conversationId, input, {
      includeOwnership: true,
      includeOperatorLabel: true,
      activity,
      redeliverMarkedReplies: true,
    });
  }

  getContactRequest(
    workspaceId: string,
    requestId: string,
    input: { limit: number; offset?: number; cursor?: string },
    activity: ConversationActivityReadScope,
  ) {
    return this.chatHistoryService.getContactRequest(
      workspaceId,
      requestId,
      input,
      dashboardConversationDetailOptions(activity),
    );
  }
}
