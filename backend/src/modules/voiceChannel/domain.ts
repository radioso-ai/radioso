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

/**
 * Where a turn's language came from, most specific first: the runtime's own record of switching
 * the call's language (`vendor_detected`), a field the runtime sets on the turn (`turn_field`), the
 * session's locale, the agent's default locale, or English when nothing names one
 * (`builtin_default`). Closed: it is logged and counted.
 */
export type VoiceTurnLanguageSource = "vendor_detected" | "turn_field" | "session" | "agent_default" | "builtin_default";

/** The language a turn speaks in, as a BCP 47 tag, and where it came from. */
export interface VoiceTurnLanguage {
  tag: string;
  source: VoiceTurnLanguageSource;
}

/** A language the request reports for its turn alone. */
export type VoiceReportedTurnLanguage = VoiceTurnLanguage & {
  source: Extract<VoiceTurnLanguageSource, "vendor_detected" | "turn_field">;
  /**
   * The language is news on this request: a per-turn field, or a switch the runtime made after the
   * caller's previous utterance. Chat is told to answer in it only then; a switch an earlier turn
   * made keeps the lines in its language and leaves chat to read the caller.
   */
  isNew: boolean;
};

/**
 * Why the newest language switch a request carries was not taken: `blocked`, the runtime refused
 * it, so the call kept the language it had; `unreadable`, Radioso could not read the switch or its
 * result, so it cannot tell which language the call is in and reports none.
 */
export type VoiceLanguageReportProblem = "blocked" | "unreadable";

/**
 * The runtime offers to switch the call's language (its voice and transcription) when the turn
 * asks it to, and has refused to switch to `refused` (primary language subtags) earlier in the
 * call, which the turn then never asks for again.
 */
export interface VoiceLanguageSwitchOffer {
  refused: readonly string[];
}

/**
 * The runtime's follow-up request after it ran the switch a turn of the session asked for:
 * `confirmed` when it switched the call, false when it refused or its result could not be read.
 */
export interface VoiceLanguageSwitchResult {
  /** The switch's id, as the turn that asked for it named it. */
  switchId: string;
  confirmed: boolean;
}

/**
 * Why a turn asks the runtime to switch the call's language: the turn's plan answers in a language
 * other than the call's. Closed: the runtime is told it as the switch's reason, and replays it, so
 * a switch carrying one of these is one Radioso asked for.
 */
export const VOICE_LANGUAGE_SWITCH_REASONS = ["response_language"] as const;

export type VoiceLanguageSwitchReason = (typeof VOICE_LANGUAGE_SWITCH_REASONS)[number];

/**
 * Where a switch a turn asked for stands, as logged and counted: asked for (`emitted`); followed up
 * by the runtime, which carried it out (`confirmed`) or refused it (`refused`); never followed up,
 * or overtaken by the caller's next utterance (`unanswered`); dropped for a follow-up of another
 * utterance (`mismatched`); or a follow-up this process holds no switched turn for (`unheld`).
 */
export type VoiceLanguageSwitchOutcome = "emitted" | "confirmed" | "refused" | "unanswered" | "mismatched" | "unheld";

export interface VoiceTurnInput {
  session: VoiceSessionRef;
  transport: VoiceTransport;
  /** The final transcript of one caller turn. */
  utterance: string;
  /** The session's language as a BCP 47 tag, when the vendor or the page that started the session names it. */
  locale?: string;
  /**
   * The language of this turn, when the request reports it apart from the session's: the language
   * the runtime switched the call to, or a per-turn field. It is the request's own; nothing stores it.
   */
  turnLanguage?: VoiceReportedTurnLanguage;
  /** Present when the newest language switch the request carries was not taken. */
  languageReport?: VoiceLanguageReportProblem;
  /** Present when the runtime offers to switch the call's language on this request. */
  languageSwitchOffer?: VoiceLanguageSwitchOffer;
  /**
   * Present on the runtime's follow-up after a switch a turn of the session asked for: the request
   * speaks that turn's answer, which its chat turn is writing or has stored, and runs no turn of
   * its own. `utterance` is then the utterance that turn answered.
   */
  languageSwitchResult?: VoiceLanguageSwitchResult;
  /**
   * The version of the agent's privacy notice the page that started the session showed and handed
   * to the call, as the request reports it (#1545). Only a session's first turn passes it on.
   */
  privacyNoticeVersion?: string;
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
  /**
   * The turn asks the runtime to switch the call to `language` (a primary language subtag such as
   * `it`) before it answers, so the answer is spoken in that language's voice. Nothing is spoken on
   * the request that carries it, before it or after it; its outcome follows at once. The runtime's
   * follow-up request (`VoiceTurnInput.languageSwitchResult`, with this `switchId`) speaks the answer.
   */
  | { type: "switchLanguage"; switchId: string; language: string; reason: VoiceLanguageSwitchReason }
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

/** The audit event a reply the caller spoke over leaves: ids and character counts, never the text. */
export const VOICE_REPLY_INTERRUPTED_EVENT = "voice.reply_interrupted";

/**
 * The `event` field of a voice turn's one log line, whichever message it carries (finished,
 * failed, abandoned, at the turn limit). The voice turn health alert counts the line by this event
 * with its `turnLimitReached` and `result` fields (`infra/terraform/monitoring.tf`), never by the
 * message's wording.
 */
export const VOICE_TURN_LOG_EVENT = "voice.turn";

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
   * Locks every session row in an erasure's scope for update, with a recording or without, so a
   * report cannot slip in between the hand-off and the rows' erasure, and returns the vendors whose
   * recordings the scope holds: the conversations named, the calls the website embed started for a
   * visitor's key, or everything the workspace holds, a call whose first turn never came and a call
   * whose agent was deleted included. The recordings themselves stay in the database: the backlog
   * copies them across in one statement.
   */
  lockRecordedVendors(scope: VoiceRecordingScope): Promise<VoiceVendor[]>;
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
    /** The vendor's `Retry-After`, in seconds, when it named one: how long it asks to be left alone. */
    readonly retryAfterSeconds?: number,
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
 * Deletes recordings at the vendor when Radioso deletes their conversations: `handOff` writes them,
 * and the workspace's vendor key, to the erasure backlog in the deletion's transaction, while both
 * still exist; the erasure job deletes them at the vendor once it committed.
 */
export type VoiceRecordingErasurePort = VendorHeldConversationDataEraser;

/**
 * A vendor key sealed for the erasure backlog, which outlives the workspace's credential store:
 * encrypted the way that store encrypts it, and opened only by the job that deletes with it.
 */
export interface VoiceVendorCredentialSealer {
  seal(credential: VoiceVendorCredential): string;
  /** Rejects when the sealed key cannot be decrypted, such as after the backend's master key changed. */
  open(sealed: string): VoiceVendorCredential;
}

/**
 * Why a recording is still at the vendor: the workspace held no key for it, a key could not be
 * decrypted, the vendor refused, could not be reached, did not answer in time or answered with
 * something else, this build knows no host for its vendor or region, or the erasure job itself
 * kept failing. A closed code, stored with the backlog and named on the recording's audit event and
 * in the organization's list; never the vendor's response.
 */
export const VOICE_RECORDING_LEFT_REASONS = [
  "credential_missing",
  "credential_unreadable",
  "vendor_rejected",
  "vendor_unreachable",
  "vendor_timeout",
  "vendor_malformed_response",
  "vendor_failed",
  "vendor_unsupported",
  "drain_failed",
] as const;

export type VoiceRecordingLeftReason = (typeof VOICE_RECORDING_LEFT_REASONS)[number];

/**
 * One deletion's recordings in one workspace at one vendor, as the deletion hands them over: the
 * scope they are copied from, and the workspace's key for the vendor, sealed, or why the deletion
 * could read none.
 */
export interface VoiceRecordingErasureHandOff {
  accountId: string;
  workspaceId: string;
  vendor: VoiceVendor;
  scope: VoiceRecordingScope;
  credential: { kind: "sealed"; sealed: string } | { kind: "absent"; reason: "credential_missing" | "credential_unreadable" };
}

/** A recording the backlog holds, as its records name it. */
export interface VoiceRecordingErasureEntry {
  id: string;
  conversationId: string | null;
  vendorConversationId: string;
  /** Asks of the vendor so far, the one a claim is for included. */
  attempts: number;
  /** Why the recording was still at the vendor after the last ask, or why no ask can be made. */
  failureReason: VoiceRecordingLeftReason | null;
}

/** A recording a claim may ask the vendor about: an entry whose region this build has a host for. */
export interface VoiceRecordingErasureItem extends VoiceRecordingErasureEntry {
  region: VoiceVendorRegion;
}

/** The erasure a run works on: the organization and workspace its recordings belong to, by id, and the held key. */
export interface VoiceRecordingErasureSubject {
  accountId: string;
  workspaceId: string;
  vendor: VoiceVendor;
  /** Null when the deletion could read no key, or once no pending recording needs it. */
  sealedCredential: string | null;
}

/**
 * One claim of an erasure: `gone` when an earlier run drained it; `unsupported_vendor` when this
 * build knows no vendor by its name (every pending recording is then left at the vendor, coded
 * `vendor_unsupported`); otherwise the recordings claimed, and those given up on at once because
 * this build knows no host for their region.
 */
export type VoiceRecordingErasureClaim =
  | { kind: "gone" }
  | { kind: "unsupported_vendor"; accountId: string; workspaceId: string; vendor: string; failed: number }
  | { kind: "batch"; erasure: VoiceRecordingErasureSubject; items: VoiceRecordingErasureItem[]; unreachable: VoiceRecordingErasureEntry[] };

/** A recording an organization's deletion left at the vendor for good, as the organization reads it. */
export interface VoiceRecordingLeftAtVendor {
  vendor: string;
  vendorRegion: string;
  vendorConversationId: string;
  conversationId: string | null;
  workspaceId: string;
  reason: VoiceRecordingLeftReason;
  failedAt: Date;
}

/** The organization's own list of recordings left at the vendor: newest first, with how many there are in all. */
export interface VoiceRecordingsLeftAtVendorReader {
  listForAccount(input: { accountId: string; limit: number }): Promise<{ total: number; recordings: VoiceRecordingLeftAtVendor[] }>;
}

/**
 * The backlog of recordings deletions left for the vendor to delete: one erasure per workspace and
 * vendor a deletion reached, with its key, and one item per recording. It names the organization,
 * workspace and conversation by id only, so it outlives every one of them.
 */
export interface VoiceRecordingErasureBacklog {
  /**
   * Inside the deletion's transaction: copies the scope's recordings at the vendor straight from
   * the voice sessions (one statement, however many), skipping any a pending row already holds, and
   * writes the erasure with its key. Returns its id and how many recordings it holds; null, writing
   * nothing, when the scope holds none.
   */
  hold(handOff: VoiceRecordingErasureHandOff): Promise<{ erasureId: string; recordings: number } | null>;
  /**
   * Claims up to `limit` of an erasure's recordings that are due, those due first: counts this ask
   * for each, and moves each one's next ask `leaseSeconds` ahead, so no other run asks about it
   * while this one does.
   */
  claim(erasureId: string, limit: number, leaseSeconds: number): Promise<VoiceRecordingErasureClaim>;
  /** The vendor no longer holds the recording: it leaves the backlog. */
  remove(itemId: string): Promise<void>;
  /** Asked and still held: kept, with why, for another ask once `delaySeconds` have passed. */
  keep(itemId: string, reason: VoiceRecordingLeftReason, delaySeconds: number): Promise<void>;
  /** Claimed and never asked: due again once `delaySeconds` have passed, its claim uncounted. */
  postpone(itemIds: readonly string[], delaySeconds: number): Promise<void>;
  /** Given up on: kept for good as left at the vendor, with why. False when the row was no longer pending. */
  fail(itemId: string, reason: VoiceRecordingLeftReason): Promise<boolean>;
  /**
   * Clears the held key once no pending recording needs it, and removes the erasure once it has no
   * recording left; reports how many are pending and when the next is due, and whether one already is.
   */
  release(erasureId: string): Promise<{ pending: number; nextAskAt: Date | null; dueNow: boolean }>;
  /**
   * Gives up on every recording the erasure still has pending, each with its last reason (or
   * `drain_failed` when it has none), and clears the key. Returns the erasure and the recordings it
   * gave up on, for their records; null when the erasure is gone.
   */
  failRemaining(erasureId: string): Promise<{ erasure: Omit<VoiceRecordingErasureSubject, "vendor"> & { vendor: string }; entries: VoiceRecordingErasureEntry[] } | null>;
  /** Erasures with a pending recording overdue by more than `overdueSeconds`: work no live job is doing. */
  overdueErasures(overdueSeconds: number, limit: number): Promise<string[]>;
}
