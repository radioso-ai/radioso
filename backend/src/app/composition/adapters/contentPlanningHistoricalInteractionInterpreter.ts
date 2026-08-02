import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ModelTurnInterpretationGateway } from "../../../modules/chat/composition.js";
import type {
  HistoricalInteractionInterpreterPort,
  ObservationSourceMessage,
} from "../../../modules/contentPlanning/services/observationSourceResolver.js";

const semanticRoles = new Set<ConversationInteractionRole>([
  "substantive_new",
  "substantive_followup",
  "clarification_value",
]);

const asMessageRecord = (
  message: Pick<ObservationSourceMessage, "id" | "role" | "content">,
  workspaceId: string,
  conversationId: string,
): MessageRecord => ({
  id: message.id,
  workspaceId,
  conversationId,
  role: message.role,
  content: message.content,
  createdAt: new Date(0),
});

export class ContentPlanningHistoricalInteractionInterpreter
implements HistoricalInteractionInterpreterPort {
  constructor(private readonly gateway: Pick<ModelTurnInterpretationGateway, "interpret">) {}

  async interpret(input: Parameters<HistoricalInteractionInterpreterPort["interpret"]>[0]) {
    const source = input.messages.find(({ id }) => id === input.sourceUserMessageId);
    if (!source || !input.workspaceId || !input.conversationId) {
      return { role: "unresolved" as const, semanticIntents: [] };
    }
    const result = await this.gateway.interpret({
      query: source.content,
      contextMessages: input.messages
        .filter(({ id }) => id !== source.id)
        .map((message) => asMessageRecord(message, input.workspaceId!, input.conversationId!)),
      usageContext: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: input.sourceUserMessageId,
        surface: "content_plan",
        operation: "historical_turn_interpretation",
        attemptKey: `content-plan-history:${input.sourceUserMessageId}`,
      },
    });
    const role = result.interactionRole ?? "unresolved";
    if (!semanticRoles.has(role)) {
      return { role, semanticIntents: [] };
    }
    const subqueries = result.rewrite?.retrievalSubqueries ?? [];
    const semanticIntents = subqueries.length > 0
      ? subqueries.map((subquery, index) => ({
          id: subquery.id || `subquery-${index}`,
          text: subquery.semanticQuery,
        }))
      : result.rewrite?.semanticQuery
        ? [{ id: "primary", text: result.rewrite.semanticQuery }]
        : [];
    return { role, semanticIntents };
  }
}
