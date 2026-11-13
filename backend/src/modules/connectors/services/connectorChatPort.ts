import {
  ITEM_SELECTION_REFUSAL_CODES,
  type AssistantClientContextCapabilities,
  type ChatAnswerPort,
  type ChatDoorPickTurnPort,
  type ChatDoorTurnReply,
  type ConversationIngestPort,
} from "../../chat/contracts/index.js";
import type { ConnectorChatPort, ConnectorReplyBlocksCapability } from "@radioso/connector-api";
import { AppError, badRequest, isStructuredAppError } from "../../../shared/domain/errors.js";
import { connectorChatOutcome, connectorTurnResult } from "./connectorTurnFacts.js";
import { CONNECTOR_IMAGES_UNUSABLE_CODE, type ConnectorImageTurns } from "./connectorImageTurns.js";

type ConnectorAnswer = Awaited<ReturnType<ConnectorChatPort["answer"]>>;

/** The capabilities a connector turn declares: the channel's reply blocks, or none. */
const capabilitiesFor = (replyBlocks: ConnectorReplyBlocksCapability | undefined): AssistantClientContextCapabilities | undefined => {
  const itemList = replyBlocks?.item_list;
  return itemList
    ? { "reply.blocks": { item_list: { layouts: [...itemList.layouts], ...(itemList.buttonLabels ? { buttonLabels: true } : {}) } } }
    : undefined;
};

/** A turn's reply as a connector receives it: the blocks only when the reply carries any. */
const connectorAnswer = (reply: ChatDoorTurnReply & { conversationId: string }): ConnectorAnswer => ({
  conversationId: reply.conversationId,
  answer: reply.answer,
  outcome: connectorChatOutcome(reply.skillOutcome),
  ...(reply.blocks?.length && reply.assistantMessageId
    ? { replyBlocks: { messageId: reply.assistantMessageId, blocks: reply.blocks } }
    : {}),
});

const isPickRefusal = (error: unknown): boolean =>
  isStructuredAppError(error)
  && (error.code === ITEM_SELECTION_REFUSAL_CODES.invalid || error.code === ITEM_SELECTION_REFUSAL_CODES.alreadySelected);

/**
 * The host side of a connector's chat port. `imageTurns` is where a turn with photos is stored,
 * read and run; a port built without it takes no photos, and refuses a turn that carries them.
 * `picks` is the chat door a card the customer picked runs through; a port built without it runs
 * a pick as the card's words.
 */
export const createConnectorChatPort = (
  chatService: ChatAnswerPort,
  conversationIngest: ConversationIngestPort,
  imageTurns: ConnectorImageTurns | null = null,
  picks: ChatDoorPickTurnPort | null = null,
): ConnectorChatPort => ({
  imageAllowance: async (input) => (imageTurns ? imageTurns.imageAllowance(input) : null),
  ingest: (input) => conversationIngest.ingest(input),
  answer: async (input) => {
    const clientContextCapabilities = capabilitiesFor(input.replyBlocks);
    const capabilities = clientContextCapabilities ? { clientContextCapabilities } : {};

    // A pick runs on the card the stored reply holds; one that names no card the conversation can
    // pick runs on the card's words as a typed message, below.
    if (input.selection && picks && input.conversationId) {
      try {
        const picked = await picks.answer({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          message: input.query,
          stream: false,
          inputMetadata: { method: "item_select", selection: input.selection },
          sourceChannel: input.sourceChannel,
          channelContext: input.channelContext,
          ...capabilities,
        });
        if (!picked?.conversationId) {
          throw new Error("Chat turn returned no conversation");
        }
        return connectorAnswer({ ...picked, conversationId: picked.conversationId });
      } catch (error) {
        if (!isPickRefusal(error)) {
          throw error;
        }
      }
    }

    const photos = input.images ?? [];
    if (photos.length > 0) {
      if (!imageTurns) {
        throw badRequest("This connector does not take images");
      }
      const answered = await imageTurns.answer({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        query: input.query,
        images: photos,
        sourceChannel: input.sourceChannel,
        channelContext: input.channelContext,
        onImagesStored: input.onImagesStored,
        ...capabilities,
      });
      if (answered) {
        return connectorAnswer(answered);
      }
      // Every photo was refused: the turn is its text, or there is nothing to answer.
      if (input.query.trim().length === 0) {
        throw new AppError(422, CONNECTOR_IMAGES_UNUSABLE_CODE, "None of the images could be used and there is no text to answer");
      }
    }

    const response = await chatService.answer({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      query: input.query,
      stream: false,
      sourceChannel: input.sourceChannel,
      channelContext: input.channelContext,
      ...capabilities,
    });

    return connectorAnswer(response);
  },
  // `review` is the only mode a connector may ask for, so the turn always runs as a review.
  respond: async (input) => connectorTurnResult(await chatService.review({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    existingUserMessageId: input.respondToMessageId,
    historyWindow: input.historyWindow,
  })),
});
