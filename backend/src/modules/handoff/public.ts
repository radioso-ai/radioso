import type { ConversationOwnershipRecord } from "./ownershipState.js";

export {
  canResume,
  isHumanOwned,
  resolveOwnership,
} from "./ownershipState.js";
export { OperatorReplyService } from "./operatorReplyService.js";
export { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
export type {
  ConversationOwnershipRecord,
  ConversationOwnershipScope,
} from "./ownershipState.js";
export type {
  ConversationOwnershipMutationResult,
} from "../../db/repositories/conversationOwnershipRepository.js";

export interface ConversationOwnershipReader {
  load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
}
