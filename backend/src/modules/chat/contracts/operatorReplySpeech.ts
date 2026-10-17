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
 * replies so that each is spoken once, by one turn, whichever instance runs it. A reply is pending
 * until a turn claims it; the claim ends spoken ({@link OperatorReplySpeechMarker}), or released
 * back to pending when the turn did not reach its caller. A claim older than
 * `VOICE_BEHAVIOR.operatorReplyClaimExpiryMs` belongs to a turn that never settled, and its
 * replies count as pending again.
 */
export interface OperatorReplySpeechClaims {
  /** The conversation's pending teammate replies, oldest first. */
  pendingOperatorReplies(input: ConversationRef): Promise<PendingOperatorReply[]>;
  /** Claims those of `messageIds` that are pending, in one write; resolves exactly the ids claimed. */
  claimOperatorReplies(input: OperatorReplyClaim): Promise<string[]>;
  /** Hands the turn's still-held claims back as pending; resolves the ids released. */
  releaseOperatorReplies(input: OperatorReplyClaim): Promise<string[]>;
  /** Marks pending replies with no words to say as skipped; resolves the ids marked. */
  skipOperatorReplies(input: ConversationRef & { messageIds: string[] }): Promise<string[]>;
}

/**
 * Records that the turn holding the claims spoke the replies. Idempotent: only a reply the turn
 * still holds is marked, so a reply spoken already keeps its first `spokenAt`, and a message that
 * is not a reply claimed by the turn is left alone. Resolves the ids this call marked.
 */
export interface OperatorReplySpeechMarker {
  markOperatorRepliesSpoken(input: OperatorReplyClaim): Promise<string[]>;
}
