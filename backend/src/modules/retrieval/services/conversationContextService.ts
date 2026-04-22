import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationContextWindow, RewriteContinuityState } from "../domain/retrievalPipelineTypes.js";

const continuityEntityCount = (state?: RewriteContinuityState): number => {
  if (!state) {
    return 0;
  }

  return new Set(
    [
      state.activeSubject,
      ...state.relatedEntities,
      ...state.groundedTitles,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  ).size;
};

export class ConversationContextService {
  select(input: { history: MessageRecord[]; query: string; rewriteContinuityState?: RewriteContinuityState }): ConversationContextWindow {
    void input.query;
    const continuityCount = continuityEntityCount(input.rewriteContinuityState);
    const maxMessages = continuityCount > 1
      ? Math.max(RETRIEVAL_BEHAVIOR.conversationContextMaxMessages, RETRIEVAL_BEHAVIOR.continuityContextMaxMessages)
      : RETRIEVAL_BEHAVIOR.conversationContextMaxMessages;

    if (input.history.length <= maxMessages) {
      return {
        selectedMessages: input.history,
        truncated: false,
        selectionReason: input.history.length === 0 ? "no-history" : "full-history",
        rewriteContinuityState: input.rewriteContinuityState,
      };
    }

    return {
      selectedMessages: input.history.slice(-maxMessages),
      truncated: true,
      selectionReason: continuityCount > 1 ? "continuity-window" : "recent-window",
      rewriteContinuityState: input.rewriteContinuityState,
    };
  }
}
