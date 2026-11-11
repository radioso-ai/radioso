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
import type { VisitorImageTurnInput } from "../../visitorImages/public.js";
import { claimVisitorImageTurn, settlingVisitorImages, type VisitorImageTurn } from "./visitorImageTurn.js";

/**
 * The text a turn runs on: the message, or a tool call rendered as the text a
 * person would have typed so the LLM-visible history matches chat.
 */
const queryFor = (input: Pick<AssistantChatRequest, "message" | "routineInvocation">): string | undefined =>
  input.routineInvocation ? renderRoutineInvocation(input.routineInvocation) : input.message?.trim();

export class AssistantChatService {
  private readonly assistantRouteService = new AssistantRouteService();
  private readonly visitorImages: VisitorImageTurnInput | null;

  constructor(
    private readonly chatService: ChatService,
    private readonly chatBootstrapService: ChatBootstrapService,
    /** Where a send's photos are claimed and bound; absent, a request with photos is refused. */
    options: { visitorImages?: VisitorImageTurnInput | null } = {},
  ) {
    this.visitorImages = options.visitorImages ?? null;
  }

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

    const images = await claimVisitorImageTurn(this.visitorImages, input);
    const query = images?.query ?? queryFor(input);
    if (!query) {
      throw badRequest("message is required unless startConversation is true");
    }

    let conversationId = input.conversationId ?? null;
    try {
      const response = await this.chatService.answer({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        bootstrapGreetingId: input.bootstrapGreetingId,
        query,
        stream: input.stream,
        userExpectedLocale: input.userExpectedLocale,
        visitorTimeZone: input.visitorTimeZone,
        inputMetadata: images?.inputMetadata ?? input.inputMetadata,
        metadataFilter: input.metadataFilter,
        pageContext: input.pageContext,
        clientContextCapabilities: input.clientContextCapabilities,
        verifiedCustomerId: input.verifiedCustomerId,
        verifiedIdentity: input.verifiedIdentity,
        requestContext: input.requestContext,
        entryReferrer: input.entryReferrer,
        privacyNoticeVersion: input.privacyNoticeVersion,
        visitorKey: input.visitorKey,
        previewRoutineIds: input.previewRoutineIds,
        routineInvocation: input.routineInvocation,
        sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
        channelContext: input.channelContext ?? input.sourceContext?.channelContext ?? null,
        chatSessionId,
        sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
      });
      conversationId = response.conversationId ?? conversationId;
      return response;
    } finally {
      await this.settleImages(input, images, conversationId);
    }
  }

  async *streamAnswer(input: AssistantChatRequest): AsyncIterable<AssistantChatStreamEvent> {
    const chatSessionId = input.chatSessionId ?? input.anonymousSessionId;
    const images = await claimVisitorImageTurn(this.visitorImages, input);
    const query = images?.query ?? queryFor(input);
    if (!query) {
      throw badRequest("message is required for streaming assistant chat");
    }

    const events = this.chatService.streamAnswer({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      bootstrapGreetingId: input.bootstrapGreetingId,
      query,
      stream: input.stream,
      userExpectedLocale: input.userExpectedLocale,
      visitorTimeZone: input.visitorTimeZone,
      inputMetadata: images?.inputMetadata ?? input.inputMetadata,
      metadataFilter: input.metadataFilter,
      pageContext: input.pageContext,
      clientContextCapabilities: input.clientContextCapabilities,
      verifiedCustomerId: input.verifiedCustomerId,
      verifiedIdentity: input.verifiedIdentity,
      requestContext: input.requestContext,
      entryReferrer: input.entryReferrer,
      privacyNoticeVersion: input.privacyNoticeVersion,
      visitorKey: input.visitorKey,
      previewRoutineIds: input.previewRoutineIds,
      routineInvocation: input.routineInvocation,
      sourceChannel: input.sourceChannel ?? input.sourceContext?.surface ?? null,
      channelContext: input.channelContext ?? input.sourceContext?.channelContext ?? null,
      chatSessionId,
      sourceOrigin: input.sourceOrigin ?? input.sourceContext?.sourceOrigin ?? null,
      supersession: input.supersession,
      deliveredReply: input.deliveredReply,
      ...(input.reportResponseLanguage ? { reportResponseLanguage: true } : {}),
      signal: input.signal,
    });
    yield* images
      ? settlingVisitorImages(events, (conversationId) => this.settleImages(input, images, conversationId), input.conversationId ?? null)
      : events;
  }

  private async settleImages(input: AssistantChatRequest, images: VisitorImageTurn | null, conversationId: string | null): Promise<void> {
    if (!images || !this.visitorImages) return;
    await this.visitorImages.settle({ workspaceId: input.workspaceId, claim: images.claim, conversationId });
  }
}
