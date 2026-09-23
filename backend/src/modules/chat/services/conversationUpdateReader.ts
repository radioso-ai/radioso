import { isHumanAuthoredMessageSource } from "../../../shared/domain/messageAuthorship.js";
import type {
  ConversationOwnershipState,
  ConversationTailReaderPort,
  ConversationUpdatePage,
  ConversationUpdateReader,
} from "../contracts/conversationUpdates.js";

// The tail omits ownership while the AI still owns the conversation, because the
// ownership row is written lazily on the first takeover.
const AI_OWNED: ConversationOwnershipState = { state: "ai_owned" };
const HUMAN_OWNED: ConversationOwnershipState = { state: "human_owned" };

/**
 * Adapts the existing conversation tail into the update page a calling agent reads.
 * The history service is not modified: this is the only place that knows an operator
 * reply is a human turn.
 */
export const createConversationUpdateReader = (
  dependencies: { history: ConversationTailReaderPort },
): ConversationUpdateReader => ({
  async read(input): Promise<ConversationUpdatePage> {
    const tail = await dependencies.history.tailConversation(
      input.workspaceId,
      input.conversationId,
      { ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit },
      { includeOwnership: true },
    );

    return {
      messages: tail.messages.map((message) => ({
        id: message.id,
        author: isHumanAuthoredMessageSource(message.source) ? "human" : "agent",
        createdAt: message.createdAt,
        text: message.content,
      })),
      cursor: tail.cursor,
      ownership: tail.ownership?.state === "human_owned" ? HUMAN_OWNED : AI_OWNED,
    };
  },
});
