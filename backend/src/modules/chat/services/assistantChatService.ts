import { badRequest } from "../../../shared/domain/errors.js";
import type { ChatBootstrapService } from "./chatBootstrapService.js";
import type { ChatService } from "./chatService.js";
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantChatStreamEvent,
} from "../types/assistantApi.js";
import { AssistantRouteService } from "./assistantRouteService.js";
import { renderRoutineInvocation } from "../../routines/public.js";

/**
 * The text a turn runs on: the message, or a tool call rendered as the text a
 * person would have typed so the LLM-visible history matches chat.
 */
const queryFor = (input: Pick<AssistantChatRequest, "message" | "routineInvocation">): string | undefined =>
  input.routineInvocation ? renderRoutineInvocation(input.routineInvocation) : input.message?.trim();

export class AssistantChatService {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatBootstrapService: ChatBootstrapService,
    private readonly assistantRouteService = new AssistantRouteService(),
  ) {}

  async answer(input: AssistantChatRequest): Promise<AssistantChatResponse | null> {
    const chatSessionId = input.chatSessionId ?? input.anonymousSessionId;
    if (input.startConversation) {
      const response = await this.chatBootstrapService.startConversation({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        accountId: input.accountId,
        sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
        channelContext: input.channelContext ?? input.sourceContext?.channelContext ?? null,
        chatSessionId,
        sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
        userExpectedLocale: input.userExpectedLocale,
        pageContext: input.pageContext,
      });
      return response
        ? {
            ...response,
            route: this.assistantRouteService.conversationStartRoute(),
          }
        : null;
    }

    const query = queryFor(input);
    if (!query) {
      throw badRequest("message is required unless startConversation is true");
    }

    const response = await this.chatService.answer({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      bootstrapGreetingId: input.bootstrapGreetingId,
      query,
      stream: input.stream,
      userExpectedLocale: input.userExpectedLocale,
      inputMetadata: input.inputMetadata,
      metadataFilter: input.metadataFilter,
      pageContext: input.pageContext,
      clientContextCapabilities: input.clientContextCapabilities,
      verifiedCustomerId: input.verifiedCustomerId,
      verifiedIdentity: input.verifiedIdentity,
      requestContext: input.requestContext,
      entryReferrer: input.entryReferrer,
      visitorKey: input.visitorKey,
      previewRoutineIds: input.previewRoutineIds,
      routineInvocation: input.routineInvocation,
      sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
      channelContext: input.channelContext ?? input.sourceContext?.channelContext ?? null,
      chatSessionId,
      sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
    });

    return response;
  }

  streamAnswer(input: AssistantChatRequest): AsyncIterable<AssistantChatStreamEvent> {
    const chatSessionId = input.chatSessionId ?? input.anonymousSessionId;
    const query = queryFor(input);
    if (!query) {
      throw badRequest("message is required for streaming assistant chat");
    }

    return this.chatService.streamAnswer({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      bootstrapGreetingId: input.bootstrapGreetingId,
      query,
      stream: input.stream,
      userExpectedLocale: input.userExpectedLocale,
      inputMetadata: input.inputMetadata,
      metadataFilter: input.metadataFilter,
      pageContext: input.pageContext,
      clientContextCapabilities: input.clientContextCapabilities,
      verifiedCustomerId: input.verifiedCustomerId,
      verifiedIdentity: input.verifiedIdentity,
      requestContext: input.requestContext,
      entryReferrer: input.entryReferrer,
      visitorKey: input.visitorKey,
      previewRoutineIds: input.previewRoutineIds,
      routineInvocation: input.routineInvocation,
      sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
      channelContext: input.channelContext ?? input.sourceContext?.channelContext ?? null,
      chatSessionId,
      sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
    });
  }
}
