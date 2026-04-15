import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationContextWindow } from "../domain/retrievalPipelineTypes.js";

export class ConversationContextService {
  select(input: { history: MessageRecord[]; query: string; rewriteCarryForwardLiterals?: string[] }): ConversationContextWindow {
    void input.query;

    if (input.history.length <= RETRIEVAL_BEHAVIOR.conversationContextMaxMessages) {
      return {
        selectedMessages: input.history,
        truncated: false,
        selectionReason: input.history.length === 0 ? "no-history" : "full-history",
        rewriteCarryForwardLiterals: input.rewriteCarryForwardLiterals,
      };
    }

    return {
      selectedMessages: input.history.slice(-RETRIEVAL_BEHAVIOR.conversationContextMaxMessages),
      truncated: true,
      selectionReason: "recent-window",
      rewriteCarryForwardLiterals: input.rewriteCarryForwardLiterals,
    };
  }
}
