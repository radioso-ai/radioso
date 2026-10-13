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
  /** The caller's language as a BCP 47 tag, when the vendor or the page that started the session names it. */
  locale?: string;
}

/** How the session goes on after the turn. */
export type VoiceTurnOutcome = { kind: "continue" };

export type VoiceTurnEvent =
  /** The conversation the turn runs in, before any speech. A bridge can precede it on a session's first turn. */
  | { type: "conversation"; conversationId: string }
  /** An authored line the channel speaks while the reply is still being written. Never stored. */
  | { type: "bridge"; text: string }
  /** A speakable piece of the agent's reply, verbatim; the final piece carries `last: true`. */
  | { type: "speech"; text: string; last: boolean }
  /** Exactly one, always last. */
  | { type: "outcome"; outcome: VoiceTurnOutcome };

export interface VoiceTurnPort {
  runTurn(input: VoiceTurnInput, signal: AbortSignal): AsyncIterable<VoiceTurnEvent>;
}

export type VoiceChannelContext = Extract<ConversationChannelContext, { provider: "voice" }>;
