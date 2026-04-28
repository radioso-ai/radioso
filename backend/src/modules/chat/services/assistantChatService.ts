import { badRequest } from "../../../shared/domain/errors.js";
import type { ChatBootstrapService } from "./chatBootstrapService.js";
import type { ChatService } from "./chatService.js";
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantChatStreamEvent,
} from "../types/assistantApi.js";
import { AssistantRouteService } from "./assistantRouteService.js";

export class AssistantChatService {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatBootstrapService: ChatBootstrapService,
    private readonly assistantRouteService = new AssistantRouteService(),
  ) {}

  async answer(input: AssistantChatRequest): Promise<AssistantChatResponse | null> {
    if (input.startConversation) {
      const response = await this.chatBootstrapService.startConversation({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
        anonymousSessionId: input.anonymousSessionId,
        sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
        userExpectedLocale: input.userExpectedLocale,
      });
      return response
        ? {
            ...response,
            route: this.assistantRouteService.conversationStartRoute(),
          }
        : null;
    }

    const query = input.message?.trim();
    if (!query) {
      throw badRequest("message is required unless startConversation is true");
    }

    const response = await this.chatService.answer({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      query,
      stream: input.stream,
      userExpectedLocale: input.userExpectedLocale,
      inputMetadata: input.inputMetadata,
      metadataFilter: input.metadataFilter,
      sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
      anonymousSessionId: input.anonymousSessionId,
      sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
    });

    return response;
  }

  streamAnswer(input: AssistantChatRequest): AsyncIterable<AssistantChatStreamEvent> {
    const query = input.message?.trim();
    if (!query) {
      throw badRequest("message is required for streaming assistant chat");
    }

    return this.chatService.streamAnswer({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      query,
      stream: input.stream,
      userExpectedLocale: input.userExpectedLocale,
      inputMetadata: input.inputMetadata,
      metadataFilter: input.metadataFilter,
      sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
      anonymousSessionId: input.anonymousSessionId,
      sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
    });
  }
}
