import { isHumanAuthoredMessageSource } from "../../../shared/domain/messageAuthorship.js";
import type {
  ConversationOwnershipState,
  ConversationTailReaderPort,
  ConversationUpdatePage,
  ConversationUpdateReader,
} from "../contracts/conversationUpdates.js";

// The tail carries no ownership until a teammate is first involved, because the ownership
// row is written lazily; after a hand-back it carries the AI-owned record.
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
