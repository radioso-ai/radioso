import { z } from "zod";

export type ConversationTurnStage =
  | "waiting"
  | "preparing"
  | "routing"
  | "rendering"
  | "persisting";

/**
 * How a newer turn on the same conversation cuts this one off.
 *
 * - `until_emission` (the default): a newer turn cancels this one only until it starts emitting its
 *   reply; after that the newer turn waits. A cancelled turn keeps its user message.
 * - `latest_input_wins`: for a channel whose newer request revises or overtakes the input in flight
 *   (a voice runtime re-sending a revised transcript, a caller speaking over the reply). A newer
 *   `latest_input_wins` turn cancels this one even after it started emitting, and a turn cancelled
 *   before it emitted anything leaves no user message behind, because the newer request replaces it.
 */
export type ConversationTurnSupersession = "until_emission" | "latest_input_wins";

/**
 * How much of a stored assistant reply the caller heard before speaking over it, counted in the
 * characters the channel spoke (the reply as speech text), not in the stored content.
 */
export const replyInterruptionSchema = z.object({
  heardCharacterCount: z.number().int().nonnegative(),
  spokenCharacterCount: z.number().int().nonnegative(),
});
export type ReplyInterruption = z.infer<typeof replyInterruptionSchema>;

/**
 * Marks a stored assistant reply as cut short, keeping the reply's text and other metadata. The
 * first marker on a reply stays as written: a later mark, with the same counts or others, changes
 * nothing. Resolves true when the conversation holds the assistant reply, which then carries a
 * marker, and false when it holds no such reply; a message that is not an assistant reply of the
 * conversation is left alone.
 */
export interface ReplyInterruptionMarker {
  markReplyInterrupted(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  } & ReplyInterruption): Promise<boolean>;
}
