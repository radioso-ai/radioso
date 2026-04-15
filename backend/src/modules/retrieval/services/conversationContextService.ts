import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationContextWindow } from "../domain/retrievalPipelineTypes.js";

const MAX_CONTEXT_MESSAGES = RETRIEVAL_BEHAVIOR.conversationContextMaxMessages;

export class ConversationContextService {
  select(input: { history: MessageRecord[]; query: string; rewriteCarryForwardLiterals?: string[] }): ConversationContextWindow {
    void input.query;

    if (input.history.length <= MAX_CONTEXT_MESSAGES) {
      return {
        selectedMessages: input.history,
        truncated: false,
        selectionReason: input.history.length === 0 ? "no-history" : "full-history",
        rewriteCarryForwardLiterals: input.rewriteCarryForwardLiterals,
      };
    }

    return {
      selectedMessages: input.history.slice(-MAX_CONTEXT_MESSAGES),
      truncated: true,
      selectionReason: "recent-window",
      rewriteCarryForwardLiterals: input.rewriteCarryForwardLiterals,
    };
  }
}
