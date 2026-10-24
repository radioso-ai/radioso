import { z } from "zod";

/**
 * Where a stored assistant reply keeps its voice turn's facts: `messages.metadata_json.voice`.
 * Chat stores the block as the voice channel reports it and reads none of it; the quality stats
 * count it by these field names.
 */
export const VOICE_TURN_FACTS_METADATA_KEY = "voice";

/**
 * How the voice turn that stored a reply went for its caller, as the voice channel measured it.
 * `firstSpeechMs`: from the start of the turn to its first speech, the reply's or the fallback
 * line's (a bridge line does not count), null when the turn spoke neither; `bridged`: a bridge
 * line was spoken before it; `turnLimitReached`: the turn reached the turn limit before it spoke;
 * `outcome`: what the voice runtime was told to do next, null when the turn ended without one.
 * Timings and closed values only, never what was said.
 */
export const voiceTurnFactsSchema = z.object({
  firstSpeechMs: z.number().nonnegative().nullable(),
  bridged: z.boolean(),
  turnLimitReached: z.boolean(),
  outcome: z.enum(["continue", "callback_requested"]).nullable(),
});
export type VoiceTurnFacts = z.infer<typeof voiceTurnFactsSchema>;

/**
 * Keeps a voice turn's facts on the assistant reply it stored, alongside the reply's other
 * metadata, with `recordedAt` (the database clock, as UTC ISO text). The first facts on a reply
 * stay as written: a later record, with the same facts or others, changes nothing. Resolves true
 * when the conversation holds the assistant reply, which then carries facts, and false when it
 * holds no such reply; a message that is not an assistant reply of the conversation is left alone.
 */
export interface VoiceTurnFactsRecorder {
  recordVoiceTurnFacts(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  } & VoiceTurnFacts): Promise<boolean>;
}
