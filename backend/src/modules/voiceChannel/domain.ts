import type { ConversationChannelContext } from "@radioso/conversation-contract";

import type { VoiceVendor } from "../../shared/domain/voiceVendor.js";

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

/** A vendor's API key, held by the workspace and read only to start that vendor's sessions. */
export interface VoiceVendorCredential {
  apiKey: string;
}

export interface VoiceVendorCredentialReader {
  /** Null when the workspace holds no key for the vendor; throws when one is stored but cannot be read. */
  read(input: { workspaceId: string; vendor: VoiceVendor }): Promise<VoiceVendorCredential | null>;
}

/** What a vendor hands back for a page to open a session on its agent. */
export interface VoiceVendorSession {
  /** The vendor's single-use URL for opening the session. A bearer: never logged. */
  signedUrl: string;
  /** When the URL stops opening sessions, when the vendor states it. */
  expiresAt?: Date;
}

/** Opens sessions on one vendor's agents. One adapter per vendor implements it. */
export interface VoiceSessionStarter {
  startSession(input: { vendorAgentId: string; credential: VoiceVendorCredential }): Promise<VoiceVendorSession>;
}

/**
 * A vendor call that did not give a session: the vendor answered with an error (`vendorStatus` is
 * its HTTP status), never answered, or answered with something that is not a session.
 */
export class VoiceVendorRequestError extends Error {
  constructor(
    readonly reason: "rejected" | "unreachable" | "malformed_response",
    readonly vendorStatus?: number,
  ) {
    super(vendorStatus === undefined ? `Voice vendor session start failed: ${reason}` : `Voice vendor session start failed: ${reason} (${vendorStatus})`);
    this.name = new.target.name;
  }
}

/**
 * How a session start ended. `started` carries what the page needs to open the session: the
 * vendor's URL, the session key the voice runtime sends back on every turn, and the caller's
 * language. `unavailable`: the agent takes no voice sessions (it is gone, voice is off, or no vendor
 * agent is bound). The two credential kinds and `vendor_failed` name the bound vendor.
 */
export type VoiceSessionStartResult =
  | { kind: "started"; vendor: VoiceVendor; signedUrl: string; sessionKey: string; locale: string; expiresAt?: Date }
  | { kind: "unavailable" }
  | { kind: "credential_missing"; vendor: VoiceVendor }
  | { kind: "credential_unreadable"; vendor: VoiceVendor }
  | { kind: "vendor_failed"; vendor: VoiceVendor };

export interface VoiceSessionStartPort {
  /** Starts a voice session for one agent. `locale` is the caller's language tag, when the page names one. */
  start(input: { workspaceId: string; agentId: string; locale?: string }): Promise<VoiceSessionStartResult>;
}
