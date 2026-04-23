import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationContextWindow } from "../domain/retrievalPipelineTypes.js";

export class ConversationContextService {
  select(input: { history: MessageRecord[] }): ConversationContextWindow {
    const maxMessages = RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages;

    if (input.history.length <= maxMessages) {
      return {
        selectedMessages: input.history,
        truncated: false,
        selectionReason: input.history.length === 0 ? "no-history" : "full-history",
      };
    }

    return {
      selectedMessages: input.history.slice(-maxMessages),
      truncated: true,
      selectionReason: "recent-window",
    };
  }
}
