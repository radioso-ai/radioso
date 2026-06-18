import type { ConversationOwnershipRecord } from "./ownershipState.js";

export {
  canResume,
  isHumanOwned,
  resolveOwnership,
} from "./ownershipState.js";
export type {
  CanResumeInput,
  CanResumeResult,
  ConversationOwnershipRecord,
  ConversationOwnershipState,
  ResolvedOwnership,
  ResumeClassification,
} from "./ownershipState.js";
export type {
  ConversationOwnershipHandBackInput,
  ConversationOwnershipMutationResult,
  ConversationOwnershipReason,
  ConversationOwnershipRequestHandoffInput,
  ConversationOwnershipTakeOverInput,
  ConversationOwnershipTransferInput,
} from "../../db/repositories/conversationOwnershipRepository.js";

export interface ConversationOwnershipReader {
  load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
}
