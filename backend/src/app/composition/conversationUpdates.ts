import {
  createConversationUpdateReader,
  createConversationUpdateWaiter,
} from "../../modules/chat/composition.js";
import type {
  ConversationTailReaderPort,
  ConversationUpdateReader,
  ConversationUpdateWaiter,
  PublicConversationEventBus,
} from "../../modules/chat/contracts/index.js";

/**
 * Default wiring for the resumption read surface: the reader over the existing
 * conversation tail, the waiter over the public conversation event bus, which hears
 * every instance (`publicConversationEvents.ts`). Both are replaceable here without the
 * converse route or the chat module learning about it.
 */
export const createConversationUpdatesComposition = (dependencies: {
  chatHistoryService: ConversationTailReaderPort;
  publicConversationEventBus: Pick<PublicConversationEventBus, "subscribe">;
}): { reader: ConversationUpdateReader; waiter: ConversationUpdateWaiter } => ({
  reader: createConversationUpdateReader({ history: dependencies.chatHistoryService }),
  waiter: createConversationUpdateWaiter({ bus: dependencies.publicConversationEventBus }),
});
