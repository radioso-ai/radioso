import type { ConversationChannelContext } from "@radioso/conversation-contract";

import type { VendorHeldConversationDataEraser, VendorHeldConversationDataScope } from "../../shared/domain/conversationDataErasure.js";
import type { VoiceVendor, VoiceVendorRegion } from "../../shared/domain/voiceVendor.js";

import type { AgentVoiceSettings } from "../agents/public.js";

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
  /**
   * The runtime receives each piece of speech as the turn hands it on (a streamed response).
   * False: it receives the whole turn at its outcome, so nothing reaches it before then.
   */
  streamsSpeech: boolean;
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

/** `unreadable`: a key is stored but cannot be decrypted, so the workspace must enter it again. */
export type VoiceVendorCredentialReading =
  | { kind: "present"; credential: VoiceVendorCredential }
  | { kind: "missing" }
  | { kind: "unreadable" };

/**
 * Whether the workspace stores a key for a vendor, without decrypting it: `unreadable` is a key
 * stored while the backend has no master key to decrypt it with.
 */
export type VoiceVendorCredentialPresence = "stored" | "missing" | "unreadable";

export interface VoiceVendorCredentialReader {
  /** Rejects only when the credential store cannot be read at all. */
  read(input: { workspaceId: string; vendor: VoiceVendor }): Promise<VoiceVendorCredentialReading>;
  /** Presence only: it decrypts nothing. Rejects only when the credential store cannot be read. */
  presence(input: { workspaceId: string; vendor: VoiceVendor }): Promise<VoiceVendorCredentialPresence>;
}

/** What a vendor hands back for a page to open a session on its agent. */
export interface VoiceVendorSession {
  /**
   * The vendor's URL for opening sessions on its agent until `expiresAt`. Whoever holds it can open
   * a session on the workspace's vendor account until then (an ElevenLabs signed URL is valid for
   * 15 minutes and is not limited to one session), so it is a bearer capability: it goes to the
   * page that asked for it and is never logged or stored.
   */
  signedUrl: string;
  /** When the URL stops opening sessions, computed from the validity the vendor documents. */
  expiresAt?: Date;
}

/**
 * Opens sessions on one vendor's agents. One adapter per vendor implements it; `region` is the
 * data residency region of the vendor account, which picks the host the adapter calls.
 */
export interface VoiceSessionStarter {
  startSession(input: { vendorAgentId: string; region: VoiceVendorRegion; credential: VoiceVendorCredential }): Promise<VoiceVendorSession>;
}

/**
 * A vendor call that did not give a session: the vendor answered with an error (`vendorStatus` is
 * its HTTP status), could not be reached, did not finish answering in time, or answered with
 * something that is not a session.
 */
export class VoiceVendorRequestError extends Error {
  constructor(
    readonly reason: "rejected" | "unreachable" | "timeout" | "malformed_response",
    readonly vendorStatus?: number,
  ) {
    super(vendorStatus === undefined ? `Voice vendor session start failed: ${reason}` : `Voice vendor session start failed: ${reason} (${vendorStatus})`);
    this.name = new.target.name;
  }
}

/**
 * The page's visitor who asked for a session: the website embed's public session and the visitor
 * key it carries. A session's first turn joins this visitor. Correlation only: holding a session
 * key grants nothing.
 */
export interface VoiceSessionVisitor {
  publicSessionId: string;
  visitorKey: string | null;
}

/**
 * The vendor agent a Radioso-started session opens on, and the data residency region of its vendor
 * account, where the vendor keeps the call's recording.
 */
export interface VoiceSessionVendorAgent {
  agentId: string;
  region: VoiceVendorRegion;
}

/** Where a started session waits for its first turn. */
export interface VoiceSessionStartRegistry {
  register(start: { session: VoiceSessionRef; visitor: VoiceSessionVisitor; expiresAt: Date; vendorAgent: VoiceSessionVendorAgent }): Promise<void>;
}

/** What a session's first turn reads of its start. */
export interface VoiceSessionStartLookup {
  /** The visitor who started the session, while the start is unexpired and no turn has bound the session. */
  findStartedVisitor(session: VoiceSessionRef): Promise<VoiceSessionVisitor | null>;
}

/**
 * How a session start ended. `started` carries what the page needs to open the session: the
 * vendor's URL, the session key the voice runtime sends back on every turn, and the caller's
 * language. `unavailable`: the agent takes no voice sessions (it is gone, voice is off, or no vendor
 * agent is bound). `failed`: the agent takes them, and this one could not be started; why is the
 * service's to log and count, never the visitor's to read.
 */
export type VoiceSessionStartResult =
  | {
    kind: "started";
    vendor: VoiceVendor;
    signedUrl: string;
    sessionKey: string;
    locale: string;
    expiresAt?: Date;
    /** The agent's recording notice in the session's language, for the page to show as the call starts. */
    recordingNotice?: string;
  }

  | { kind: "unavailable" }
  | { kind: "failed" };

/**
 * What can keep an agent's voice from being ready, in the order an operator sets them up: the voice
 * channel, the runtime binding, the vendor key, then the backend's master key to read it. The API
 * contract's `VoiceCallReadiness.missing` is this list.
 */
export const VOICE_CALL_READINESS_GAPS = ["voice_channel", "runtime", "vendor_key", "encryption"] as const;

export type VoiceCallReadinessGap = (typeof VOICE_CALL_READINESS_GAPS)[number];

/** Whether an agent's voice is ready for sessions, and when it is not, the first piece missing. */
export type VoiceCallReadiness =
  | { ready: true; missing: null }
  | { ready: false; missing: VoiceCallReadinessGap };

/**
 * Whether an agent's voice is ready for sessions. It reads the agent's own `voice` block, which its
 * caller already holds, and only the key's presence. `readiness` says what is missing, for the
 * operator's dashboard; `isAvailable` is the yes or no a page may learn, and names nothing about
 * the vendor or the key.
 */
export interface VoiceSessionAvailabilityPort {
  /** Rejects when the credential store cannot be read. */
  readiness(input: { workspaceId: string; voice: Pick<AgentVoiceSettings, "enabled" | "runtime"> }): Promise<VoiceCallReadiness>;
  /** Never rejects: a store that cannot be read reads as not ready, and is logged. */
  isAvailable(input: { workspaceId: string; voice: Pick<AgentVoiceSettings, "enabled" | "runtime"> }): Promise<boolean>;
}

export interface VoiceSessionStartPort {
  /** Starts a voice session for one agent and visitor. `locale` is the caller's language tag, when the page names one. */
  start(input: { workspaceId: string; agentId: string; visitor: VoiceSessionVisitor; locale?: string }): Promise<VoiceSessionStartResult>;
}

/**
 * Where a call's recording lives: the vendor that holds it, the data residency region of the vendor
 * account (which picks the vendor host), and the vendor's own id for the call. The id comes from the
 * visitor's page and is stored only once the vendor confirmed it is a call on the session's vendor
 * agent; it is only ever looked up with the workspace's own vendor key.
 */
export interface VoiceRecordingLocation {
  vendor: VoiceVendor;
  region: VoiceVendorRegion;
  vendorConversationId: string;
}

/** A conversation's recording, as the Inbox plays it. */
export interface VoiceRecordingRef extends VoiceRecordingLocation {
  conversationId: string;
}

/**
 * A recording an erasure asks the vendor to delete. `conversationId` is null for a call whose page
 * reported it but whose first turn never came: the vendor still holds it, and Radioso still has to.
 */
export interface VoiceRecordingToErase extends VoiceRecordingLocation {
  workspaceId: string;
  conversationId: string | null;
}

/** What a report is checked against: the vendor agent and region the reporting session was started on. */
export interface VoiceReportableSession {
  vendor: VoiceVendor;
  vendorAgent: VoiceSessionVendorAgent;
}

/** A Radioso-started session the page reports the vendor's conversation id for. */
export interface VoiceVendorConversationReport {
  workspaceId: string;
  agentId: string;
  sessionKey: string;
  /** The website embed public session that reports it: it must be the one the session was started for. */
  publicSessionId: string;
  vendorConversationId: string;
}

/** `voice_sessions` as the recording reads it. */
export interface VoiceRecordingStore {
  /**
   * The session a report names, while it waits for one: Radioso started it for this public session,
   * its start is unexpired, and it has no vendor conversation id yet. Null otherwise.
   */
  findReportableSession(report: Omit<VoiceVendorConversationReport, "vendorConversationId">): Promise<VoiceReportableSession | null>;
  /**
   * Stores the vendor's conversation id on that session, once. False when it no longer waits for
   * one, or another session already holds the id.
   */
  recordVendorConversation(report: VoiceVendorConversationReport): Promise<boolean>;
  /** The recording of a conversation of the workspace, when its page reported one. */
  findRecording(input: { workspaceId: string; conversationId: string }): Promise<VoiceRecordingRef | null>;
  /**
   * Every recording in an erasure's scope: the conversations named, the calls the website embed
   * started for a visitor's key, or everything the workspace holds, a call whose first turn never
   * came and a call whose agent was deleted included. Locks every session row in scope for update,
   * with a recording or without, so a report cannot slip in between the read and the rows' erasure.
   */
  listRecordings(scope: VoiceRecordingScope): Promise<VoiceRecordingToErase[]>;
}

/**
 * The conversations an erasure removes, the calls a visitor started before any conversation of
 * theirs (by the visitor's key), or a whole workspace just before it is deleted.
 */
export type VoiceRecordingScope = VendorHeldConversationDataScope;

/**
 * A recording as the vendor serves it. `status` is 206 when the vendor answered a byte range, with
 * `contentRange`; the body streams straight from the vendor and is never buffered or stored.
 */
export interface VoiceRecordingStream {
  status: 200 | 206;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: string;
}

/**
 * A vendor call about a recording that did not succeed: the vendor holds no recording under that
 * id (the call has not finished, or the conversation is gone), cannot serve the byte range asked
 * for (`contentRange` is the vendor's, naming the recording's length), refused the request
 * (`vendorStatus` is its HTTP status), could not be reached, did not answer in time or stopped
 * sending, answered with something that is not what was asked for, or with far more than it could
 * be (`oversized_response`, which a later try may not meet). `abandoned`: the listener
 * went away first, which is nobody's failure.
 */
export class VoiceRecordingRequestError extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "range_not_satisfiable"
      | "rejected"
      | "unreachable"
      | "timeout"
      | "malformed_response"
      | "oversized_response"
      | "abandoned",
    readonly vendorStatus?: number,
    readonly contentRange?: string,
  ) {
    super(vendorStatus === undefined ? `Voice recording request failed: ${reason}` : `Voice recording request failed: ${reason} (${vendorStatus})`);
    this.name = new.target.name;
  }
}

/** One vendor's recordings, read and deleted with the workspace's key. One adapter per vendor. */
export interface VoiceRecordingSource {
  /** The vendor agent a conversation was held on: the check a reported id must pass before it is stored. */
  describeConversation(input: {
    vendorConversationId: string;
    region: VoiceVendorRegion;
    credential: VoiceVendorCredential;
  }): Promise<{ vendorAgentId: string }>;
  /** `range` is the listener's `Range` header, passed on when it names one byte range. */
  fetchRecording(input: {
    vendorConversationId: string;
    region: VoiceVendorRegion;
    credential: VoiceVendorCredential;
    range?: string;
    signal?: AbortSignal;
  }): Promise<VoiceRecordingStream>;
  /** Resolves once the vendor no longer holds the conversation: `already_absent` when it held none to delete. */
  deleteRecording(input: {
    vendorConversationId: string;
    region: VoiceVendorRegion;
    credential: VoiceVendorCredential;
    /** Aborted when the caller gives up on it; the delete then rejects as `abandoned`. */
    signal?: AbortSignal;
  }): Promise<"deleted" | "already_absent">;
}

/**
 * The page reports the vendor's conversation id for a session it opened. `rejected`: no session
 * Radioso started for this public session waits for an id, or the vendor says the id is a call on
 * another vendor agent. `failed`: the id could not be checked now, the vendor not showing the
 * conversation yet included; the page may report it again.
 */
export interface VoiceVendorConversationReportPort {
  report(input: VoiceVendorConversationReport): Promise<"recorded" | "rejected" | "failed">;
}

/**
 * Whether a conversation's call has a recording a teammate can play, from Radioso's records alone,
 * without asking the vendor. One answer for every reader: the Inbox's detail and Ray's transcript.
 */
export interface VoiceRecordingAvailabilityPort {
  /**
   * Null for a conversation that is not a call, and for one whose records cannot be read now (which
   * is logged). Never rejects.
   */
  availability(input: { workspaceId: string; conversationId: string; sourceChannel: string | null }): Promise<boolean | null>;
}

/**
 * How opening a recording for an operator ended. `not_found`: the conversation has no recording, or
 * the vendor holds none (yet). `range_not_satisfiable`: the byte range lies past the recording's
 * end. `unavailable`: there is one, and it could not be read now. `abandoned`: the listener went
 * away before the vendor answered; nothing is left to answer.
 */
export type VoiceRecordingPlayback =
  | { kind: "recording"; recording: VoiceRecordingStream }
  | { kind: "not_found" }
  | { kind: "range_not_satisfiable"; contentRange?: string }
  | { kind: "unavailable" }
  | { kind: "abandoned" };

export interface VoiceRecordingPlaybackPort {
  /** Opens a conversation's recording for one operator; a recording that opens is audited as played. */
  play(input: { workspaceId: string; conversationId: string; actorUserId: string | null; range?: string; signal?: AbortSignal }): Promise<VoiceRecordingPlayback>;
}

/**
 * Deletes recordings at the vendor when Radioso deletes their conversations. `prepare` runs while
 * the conversations, and the workspace's vendor key, still exist; `erase` runs once they are gone,
 * and never rejects: a recording the vendor would not delete is logged, with where it is, and left
 * there.
 */
export type VoiceRecordingErasurePort = VendorHeldConversationDataEraser;
