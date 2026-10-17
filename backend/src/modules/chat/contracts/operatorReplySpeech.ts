import type { ConversationChannelContext } from "@radioso/conversation-contract";
import { z } from "zod";

/**
 * Where a teammate's reply stands on a conversation whose caller hears replies rather than reads
 * them, as readers see it: `pending` from the moment it is stored, `spoken` once a turn of the call
 * spoke it (`spokenAt`: when that turn completed), `skipped` when it has no words a call can
 * speak. A call speaks only when its caller does, so a reply waits for the caller's next turn.
 */
export const operatorReplySpeechSchema = z.object({
  state: z.enum(["pending", "spoken", "skipped"]),
  spokenAt: z.string().datetime().optional(),
});
export type OperatorReplySpeech = z.infer<typeof operatorReplySpeechSchema>;

/** Whether teammate replies on the conversation are spoken to its caller, and so wait for a turn. */
export const operatorRepliesAreSpoken = (conversation: { channelContext: ConversationChannelContext | null }): boolean =>
  conversation.channelContext?.provider === "voice";

/** A teammate's reply the caller has not heard yet. */
export interface PendingOperatorReply {
  messageId: string;
  /** The reply as the teammate wrote it; the speaking channel turns it into speech. */
  text: string;
}

interface ConversationRef {
  workspaceId: string;
  conversationId: string;
}

/** Teammate replies of the conversation, and the turn that claims them. */
export interface OperatorReplyClaim extends ConversationRef {
  messageIds: string[];
  claimTurnId: string;
}

/**
 * The teammate replies a call has yet to speak, and the claims turns hold on them, kept with the
 * replies so that each is spoken once, by one turn, whichever instance runs it. A turn claims every
 * pending reply of the conversation in one write; the claim then ends `spoken`, `skipped` (the
 * reply had no words to say), or released back to pending when the turn did not reach its caller.
 * Every call changes only replies the turn still holds and resolves exactly the ids it changed. A
 * claim older than `VOICE_BEHAVIOR.operatorReplyClaimExpiryMs` belongs to a turn that never
 * settled, and its replies count as pending again.
 */
export interface OperatorReplySpeechClaims {
  /** Claims the conversation's pending replies for the turn; resolves them, oldest first. */
  claimPendingOperatorReplies(input: ConversationRef & { claimTurnId: string }): Promise<PendingOperatorReply[]>;
  /** The turn spoke them and completed; a reply spoken already keeps its first `spokenAt`. */
  markOperatorRepliesSpoken(input: OperatorReplyClaim): Promise<string[]>;
  /** The turn had nothing to say for them. */
  skipOperatorReplies(input: OperatorReplyClaim): Promise<string[]>;
  /** The turn did not reach its caller; the replies wait for the next turn. */
  releaseOperatorReplies(input: OperatorReplyClaim): Promise<string[]>;
}
