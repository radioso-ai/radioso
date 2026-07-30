import { SKILL_TURN_OUTCOME, type ChatAnswerPort } from "../../chat/contracts/index.js";
import type { ConnectorChatPort } from "@radioso/connector-api";

type ConnectorChatOutcome = Awaited<ReturnType<ConnectorChatPort["answer"]>>["outcome"];

/**
 * Maps the turn's skill outcome onto the connector-facing result. Declines and
 * generation failure stay distinct so connectors can escalate only real content gaps
 * without presenting provider/configuration failures as successful answers.
 */
const toConnectorOutcome = (skillOutcome: string | undefined): ConnectorChatOutcome => {
  if (skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome) {
    return "no_context";
  }
  if (skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_OUT_OF_SCOPE.outcome) {
    return "out_of_scope";
  }
  if (skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE.outcome) {
    return "unavailable";
  }
  return "answered";
};

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
      outcome: toConnectorOutcome(response.skillOutcome),
    };
  },
});
