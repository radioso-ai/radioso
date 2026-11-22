import type { ConversationSourceScope } from "../../../shared/domain/conversationSource.js";
import type { ConversationActivityReadScope } from "../../conversationActivity/contracts/index.js";
import type { ConversationAttributeFilterInput, ConversationAttributeReader } from "../../context-variables/public.js";
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

/** A history list's input as a caller names an attribute filter: by the attribute's name and an option key. */
type WithAttributeFilterInput<Input> = Omit<Input, "attribute"> & { attribute?: ConversationAttributeFilterInput };

export class AssistantHistoryService {
  constructor(
    private readonly chatHistoryService: ChatHistoryService,
    private readonly attributes: ConversationAttributeReader,
  ) {}

  async listConversations(
    workspaceId: string,
    input: WithAttributeFilterInput<{
      limit: number;
      offset?: number;
      cursor?: string;
      sourceScope?: ConversationSourceScope;
      ownership?: ConversationOwnershipScope;
      agentId?: string;
      channel?: string;
    }>,
  ) {
    return this.chatHistoryService.listConversations(workspaceId, await this.withResolvedAttribute(workspaceId, input));
  }

  async listItems(
    workspaceId: string,
    input: WithAttributeFilterInput<{ limit: number; offset?: number; sourceScope?: ConversationSourceScope } & HistoryItemsFilters>,
  ) {
    return this.chatHistoryService.listItems(workspaceId, await this.withResolvedAttribute(workspaceId, input));
  }

  /** Resolves an attribute filter to the stored value it matches, refusing one no conversation can satisfy. */
  private async withResolvedAttribute<Input extends { attribute?: ConversationAttributeFilterInput }>(workspaceId: string, input: Input) {
    const { attribute, ...rest } = input;
    return attribute ? { ...rest, attribute: await this.attributes.resolveFilter(workspaceId, attribute) } : rest;
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

  async getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
    activity: ConversationActivityReadScope,
  ) {
    // Dashboard surface: include operator-only ownership and agent details, and the conversation's
    // attributes. The public visitor path calls chatHistoryService.getConversation directly and
    // never sets these.
    const [conversation, attributes] = await Promise.all([
      this.chatHistoryService.getConversation(workspaceId, conversationId, input, dashboardConversationDetailOptions(activity)),
      this.attributes.read(workspaceId, conversationId),
    ]);
    return { ...conversation, attributes };
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
