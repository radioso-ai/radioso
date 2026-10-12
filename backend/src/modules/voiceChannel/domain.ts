import type { ConversationChannelContext } from "@radioso/conversation-contract";

export type VoiceTransport = "phone" | "web";

/** One voice session, which maps to exactly one conversation. */
export interface VoiceSessionRef {
  workspaceId: string;
  agentId: string;
  /** The namespace `sessionKey` belongs to: the voice runtime that issued it. */
  vendor: string;
  /** The vendor's call or session id, opaque to Radioso. */
  sessionKey: string;
}

export interface VoiceTurnInput {
  session: VoiceSessionRef;
  transport: VoiceTransport;
  /** The final transcript of one caller turn. */
  utterance: string;
}

/** How the session goes on after the turn. */
export type VoiceTurnOutcome = { kind: "continue" };

export type VoiceTurnEvent =
  /** The conversation the turn runs in, before any speech. */
  | { type: "conversation"; conversationId: string }
  /** A speakable piece of the agent's reply, verbatim; the final piece carries `last: true`. */
  | { type: "speech"; text: string; last: boolean }
  /** Exactly one, always last. */
  | { type: "outcome"; outcome: VoiceTurnOutcome };

export interface VoiceTurnPort {
  runTurn(input: VoiceTurnInput, signal: AbortSignal): AsyncIterable<VoiceTurnEvent>;
}

export type VoiceChannelContext = Extract<ConversationChannelContext, { provider: "voice" }>;
