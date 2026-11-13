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
import { claimVisitorImageTurn } from "./visitorImageTurn.js";
import type { ItemSelectionTurn, ItemSelectionTurns } from "./replyBlocks/itemSelectionTurn.js";

/**
 * The text a turn runs on: the message, or a tool call rendered as the text a
 * person would have typed so the LLM-visible history matches chat.
 */
const queryFor = (input: Pick<AssistantChatRequest, "message" | "routineInvocation">): string | undefined =>
  input.routineInvocation ? renderRoutineInvocation(input.routineInvocation) : input.message?.trim();

export class AssistantChatService {
  private readonly assistantRouteService = new AssistantRouteService();
  private readonly visitorImages: VisitorImageTurnInput | null;
  private readonly itemSelections: Pick<ItemSelectionTurns, "claim"> | null;

  constructor(
    private readonly chatService: ChatService,
    private readonly chatBootstrapService: ChatBootstrapService,
    /**
     * Where a send's photos are claimed, bound and let go, and where a picked card is read from its
     * stored block; absent, a request with photos or a pick is refused.
     */
    options: { visitorImages?: VisitorImageTurnInput | null; itemSelections?: Pick<ItemSelectionTurns, "claim"> | null } = {},
  ) {
    this.visitorImages = options.visitorImages ?? null;
    this.itemSelections = options.itemSelections ?? null;
  }

  /** A pick's turn, or null for a message sent any other way. Claimed before photos, so a refused pick claims none. */
  private async claimItemSelection(input: AssistantChatRequest): Promise<ItemSelectionTurn | null> {
    if (input.inputMetadata?.method !== "item_select") {
      return null;
    }
    if (!this.itemSelections) {
      throw badRequest("Selections are not accepted on this request");
    }
    return this.itemSelections.claim(input);
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

    const selected = await this.claimItemSelection(input);
    const images = await claimVisitorImageTurn(this.visitorImages, input);
    const query = selected?.query ?? images?.query ?? queryFor(input);
    if (!query) {
      throw badRequest("message is required unless startConversation is true");
    }

    try {
      return await this.chatService.answer({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        bootstrapGreetingId: input.bootstrapGreetingId,
        query,
        stream: input.stream,
        userExpectedLocale: input.userExpectedLocale,
        visitorTimeZone: input.visitorTimeZone,
        inputMetadata: selected?.inputMetadata ?? images?.inputMetadata ?? input.inputMetadata,
        itemSelection: selected?.item,
        onUserMessageStored: selected?.onUserMessageStored ?? images?.onUserMessageStored,
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
    } finally {
      await images?.finish();
    }
  }

  async *streamAnswer(input: AssistantChatRequest): AsyncIterable<AssistantChatStreamEvent> {
    const chatSessionId = input.chatSessionId ?? input.anonymousSessionId;
    const selected = await this.claimItemSelection(input);
    const images = await claimVisitorImageTurn(this.visitorImages, input);
    const query = selected?.query ?? images?.query ?? queryFor(input);
    if (!query) {
      throw badRequest("message is required for streaming assistant chat");
    }

    try {
      yield* this.chatService.streamAnswer({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        bootstrapGreetingId: input.bootstrapGreetingId,
        query,
        stream: input.stream,
        userExpectedLocale: input.userExpectedLocale,
        visitorTimeZone: input.visitorTimeZone,
        inputMetadata: selected?.inputMetadata ?? images?.inputMetadata ?? input.inputMetadata,
        itemSelection: selected?.item,
        onUserMessageStored: selected?.onUserMessageStored ?? images?.onUserMessageStored,
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
    } finally {
      await images?.finish();
    }
  }
}
