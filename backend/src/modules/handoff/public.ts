import type { ConversationOwnershipRecord } from "./ownershipState.js";

export {
  canResume,
  isHumanOwned,
  ownerLabel,
  presentOwnership,
  resolveOwnership,
} from "./ownershipState.js";
export { OperatorReplyService } from "./operatorReplyService.js";
export { OperatorIdentityResolver, type OperatorIdentity } from "./operatorIdentity.js";
export type { ConversationOperator, ConversationOperatorDirectory } from "./conversationOperatorDirectory.js";
export {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationTransferNoticeActionHandler,
  ConversationTransferNotices,
} from "./transferNotice.js";
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
