import type { ConversationOwnershipRecord } from "./ownershipState.js";

export {
  canResume,
  isHumanOwned,
  ownerLabel,
  presentOwnership,
} from "./ownershipState.js";
export { OperatorReplyService } from "./operatorReplyService.js";
export { OperatorIdentityResolver, type OperatorIdentity } from "./operatorIdentity.js";
export type { ConversationOperator, ConversationOperatorDirectory } from "./conversationOperatorDirectory.js";
export {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationTransferNoticeActionHandler,
  transferNoticeRequest,
} from "./transferNotice.js";
export {
  ConversationOwnershipService,
  type HumanOwnershipRequestScope,
  type OwnershipActor,
  type OwnershipChangeUnitOfWork,
  type OwnershipReplyUnitOfWork,
} from "./conversationOwnershipService.js";
export type {
  ConversationOwnershipRecord,
  ConversationOwnershipScope,
} from "./ownershipState.js";

export interface ConversationOwnershipReader {
  load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
}
