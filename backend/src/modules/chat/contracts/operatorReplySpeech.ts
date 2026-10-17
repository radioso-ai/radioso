import type { ConversationChannelContext } from "@radioso/conversation-contract";
import { z } from "zod";

/**
 * Where a teammate's reply stands on a conversation whose caller hears replies rather than reads
 * them: `pending` from the moment it is stored, `spoken` (with when) once a turn of the call has
 * handed it to the caller. A call speaks only when its caller does, so a reply waits for the
 * caller's next turn.
 */
export const operatorReplySpeechSchema = z.object({
  state: z.enum(["pending", "spoken"]),
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
  createdAt: Date;
}

/** The teammate replies a conversation holds that its caller has not heard yet, oldest first. */
export interface PendingOperatorReplyReader {
  pendingOperatorReplies(input: { workspaceId: string; conversationId: string }): Promise<PendingOperatorReply[]>;
}

/**
 * Records that the caller heard teammate replies of the conversation. Idempotent: a reply already
 * spoken keeps the time it was first spoken, and a message that is not a pending reply of the
 * conversation is left alone. Resolves the ids this call marked, in no particular order.
 */
export interface OperatorReplySpeechMarker {
  markOperatorRepliesSpoken(input: { workspaceId: string; conversationId: string; messageIds: string[] }): Promise<string[]>;
}
