import type { ChatAnswerPort } from "../../chat/contracts/index.js";
import type { ConnectorChatPort } from "@radioso/connector-api";

export const createConnectorChatPort = (chatService: ChatAnswerPort): ConnectorChatPort => ({
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
      outcome: response.skillOutcome === "no_context" ? "no_context" : "answered",
    };
  },
});
