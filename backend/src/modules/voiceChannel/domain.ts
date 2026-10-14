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
  /**
   * The agent's previous reply as far as the caller heard it before speaking over it, when the
   * vendor reports it (ElevenLabs replays it cut short in the request's history).
   */
  heardUntil?: string;
  /**
   * The shortest first sentence the runtime speaks before more text arrives, when it holds shorter
   * ones back; the turn prefers bridge lines at least this long.
   */
  minReleasableSentenceChars?: number;
}

/**
 * How the session goes on after the turn. `callback_requested`: the turn handed the conversation
 * to a person after its routine collected something from the caller, so the team follows up;
 * `handoffReason` says why it handed off. The runtime keeps the line open either way.
 */
export type VoiceTurnOutcome =
  | { kind: "continue" }
  | { kind: "callback_requested"; handoffReason?: string };

export type VoiceTurnEvent =
  /** The conversation the turn runs in, before any speech. A bridge can precede it on a session's first turn. */
  | { type: "conversation"; conversationId: string }
  /** An authored line the channel speaks while the reply is still being written. Never stored. */
  | { type: "bridge"; text: string }
  /** A speakable piece of the agent's reply, verbatim; the final piece carries `last: true`. */
  | { type: "speech"; text: string; last: boolean }
  /** Exactly one, always last: the turn's events end with it. */
  | { type: "outcome"; outcome: VoiceTurnOutcome };

/**
 * A turn whose events broke the port's contract: they must end with exactly one outcome. The
 * adapter answers it like any failed turn, so the runtime never reads it as a finished reply.
 */
export class VoiceTurnProtocolError extends Error {
  constructor(readonly violation: "missing_outcome" | "second_outcome" | "event_after_outcome") {
    super(`Voice turn broke the port contract: ${violation}`);
    this.name = new.target.name;
  }
}

/** A turn that ended without its outcome, such as one whose chat stream ended without `done` or `cancelled`. */
export class VoiceTurnIncompleteError extends VoiceTurnProtocolError {
  constructor() {
    super("missing_outcome");
  }
}

export interface VoiceTurnPort {
  /**
   * Runs one caller turn. `signal` aborts it. `hungUp`, when the adapter observes it, fires when
   * the runtime closes the request before the turn's outcome reached it: the turn runs on and its
   * reply is stored, and the session remembers that the caller did not hear it.
   */
  runTurn(input: VoiceTurnInput, signal: AbortSignal, hungUp?: AbortSignal): AsyncIterable<VoiceTurnEvent>;
}

export type VoiceChannelContext = Extract<ConversationChannelContext, { provider: "voice" }>;
