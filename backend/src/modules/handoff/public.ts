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
export {
  autoDispatchRefusal,
  autoSendRefusal,
  heldBirth,
  HELD_REPLY_STATES,
  heldReplyEventSources,
  heldReplyEventTarget,
  heldReplyTransition,
  isHeldReplyAttentionOpen,
  releaseRefusal,
  type HeldReplyBindingCheck,
  type HeldReplyEvent,
  type HeldReplyRecord,
  type HeldReplyState,
} from "./heldReplies/heldReplyState.js";
// Producers call hold or queueAuto; a channel's send handler calls materializeAuto on a queued send,
// and its sweep returnAbandonedAuto on one whose dispatch gave up.
export {
  HeldReplyService,
  type HeldReplyAuthorityView,
  type HeldReplyChannelScope,
  type HeldReplyDispatchPort,
  type HeldReplyInsert,
  type HeldReplyProducerPort,
  type HeldReplyReadStore,
  type HeldReplySupersedeScope,
  type HeldReplyUnitOfWork,
  type HeldReplyView,
  type HeldReplyWriteStore,
  type HoldReplyInput,
  type QueueAutoInput,
} from "./heldReplies/heldReplyService.js";

export interface ConversationOwnershipReader {
  load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
}
