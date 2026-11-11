import type { ChatAnswerPort, ConversationIngestPort } from "../../chat/contracts/index.js";
import type { ConnectorChatPort } from "@radioso/connector-api";
import { AppError, badRequest } from "../../../shared/domain/errors.js";
import { connectorChatOutcome, connectorTurnResult } from "./connectorTurnFacts.js";
import { CONNECTOR_IMAGES_UNUSABLE_CODE, type ConnectorImageTurns } from "./connectorImageTurns.js";

/**
 * The host side of a connector's chat port. `imageTurns` is where a turn with photos is stored,
 * read and run; a port built without it takes no photos, and refuses a turn that carries them.
 */
export const createConnectorChatPort = (
  chatService: ChatAnswerPort,
  conversationIngest: ConversationIngestPort,
  imageTurns: ConnectorImageTurns | null = null,
): ConnectorChatPort => ({
  imageAllowance: async (input) => (imageTurns ? imageTurns.imageAllowance(input) : null),
  ingest: (input) => conversationIngest.ingest(input),
  answer: async (input) => {
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
      });
      if (answered) {
        return {
          conversationId: answered.conversationId,
          answer: answered.answer,
          outcome: connectorChatOutcome(answered.skillOutcome),
        };
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
    });

    return {
      conversationId: response.conversationId,
      answer: response.answer,
      outcome: connectorChatOutcome(response.skillOutcome),
    };
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
