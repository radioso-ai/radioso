import type { ChatAnswerPort, ConversationIngestPort } from "../../chat/contracts/index.js";
import type { ConnectorChatPort } from "@radioso/connector-api";
import { connectorChatOutcome, connectorTurnResult } from "./connectorTurnFacts.js";

export const createConnectorChatPort = (
  chatService: ChatAnswerPort,
  conversationIngest: ConversationIngestPort,
): ConnectorChatPort => ({
  ingest: (input) => conversationIngest.ingest(input),
  answer: async (input) => {
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
