import type { ChatService } from "../../chat/services/chatService.js";
import type { ConnectorChatPort } from "@radioso/connector-api";

export const createConnectorChatPort = (chatService: ChatService): ConnectorChatPort => ({
  answer: async (input) => {
    const response = await chatService.answer({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      query: input.query,
      stream: false,
      sourceChannel: input.sourceChannel,
    });

    return {
      conversationId: response.conversationId,
      answer: response.answer,
    };
  },
});
