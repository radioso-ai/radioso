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
 * conversation tail, the waiter over the existing in-process event bus. Both are
 * replaceable here — a deployment that gains a cross-instance bus swaps the waiter's
 * source without the converse route or the chat module learning about it.
 */
export const createConversationUpdatesComposition = (dependencies: {
  chatHistoryService: ConversationTailReaderPort;
  publicConversationEventBus: Pick<PublicConversationEventBus, "subscribe">;
}): { reader: ConversationUpdateReader; waiter: ConversationUpdateWaiter } => ({
  reader: createConversationUpdateReader({ history: dependencies.chatHistoryService }),
  waiter: createConversationUpdateWaiter({ bus: dependencies.publicConversationEventBus }),
});
