import type { AuditEventInput } from "../../audit/contracts/index.js";
import type { MessageCreateInput } from "../../../db/repositories/messageRepository.js";

/** The heard part of a reply a newer input cut off mid-stream, and the records of the cut. */
export interface CutReplyStoreInput {
  workspaceId: string;
  conversationId: string;
  /** Already marked cut short. */
  assistantMessage: MessageCreateInput & { id: string };
  /** The turn's cancelled `chat.answer` event naming the message, then the channel's own record of the cut. */
  auditEvents: readonly AuditEventInput[];
}

/**
 * Where the heard part of a cut-off reply is kept: the message, the conversation's touch and the
 * audit events in one transaction, so the part is never stored without its records.
 */
export interface CutReplyStore {
  storeCutReply(input: CutReplyStoreInput): Promise<void>;
}
