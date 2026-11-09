// Generic clarification: candidates, the ask/offer decision, the pending row, and the
// clarifier port. Payloads are opaque here; only the originating surface reads them.
import type { TurnContext } from "./index.js";

/**
 * A detector-supplied option for a generic clarification decision. The payload is
 * opaque to the Clarifier and is interpreted only by the originating surface.
 */
export interface ClarificationCandidate {
  id: string;
  label: string;
  description?: string;
  /** Ordinal confidence within this candidate set only; never compare across sets. */
  confidence: number;
  payload: unknown;
}

/** Per-surface policy for deciding whether candidates are clear enough to avoid asking. */
export interface ClarificationPolicy {
  /** Minimum confidence required for a candidate to remain in the decision set. */
  floor: number;
  /** Top-vs-runner-up gap that counts as a clear winner. */
  margin: number;
  /**
   * Inner ask boundary for the two-band policy. Values are expected to be less
   * than or equal to `margin`; when absent this defaults to `margin`, leaving an
   * empty soft-pick band and preserving the single-margin behavior.
   */
  askMargin?: number;
  /** Maximum number of candidates presented in a clarifying question. */
  maxOptions: number;
}

/** `soft_band`: a surface that acts on a soft pick without offering its alternatives. */
export type ClarificationAutoPickReason = "clear_margin" | "priority" | "suppressed" | "loop_guard" | "soft_band";

/**
 * Pure clarification decision returned by engine-layer policy evaluation. `soft_pick` acts on
 * the leader and offers the alternatives; `offer` acts on nothing and offers the leader, which
 * the visitor may accept on the next turn. Only a surface's own rule produces `offer`.
 */
export type ClarificationDecision =
  | { kind: "auto_pick"; candidate: ClarificationCandidate; reason: ClarificationAutoPickReason }
  | { kind: "soft_pick"; candidate: ClarificationCandidate; alternatives: ClarificationCandidate[] }
  | { kind: "offer"; candidate: ClarificationCandidate }
  | { kind: "ask"; candidates: ClarificationCandidate[] }
  | { kind: "none" };

export interface RoutineActivationDecisionMetadata {
  consideredCandidates: ClarificationCandidate[];
  decision: ClarificationDecision;
  reason?: string;
  margin?: number;
}

export type PendingClarificationStatus = "pending" | "resolved" | "declined" | "expired";
export type PendingClarificationMode = "ask" | "offer";

/** Conversation-scoped pending clarification row, including the presented opaque candidates. */
export interface PendingClarification {
  sessionId: string;
  source: string;
  /** Originating user message; nulled by stores once the row leaves pending status. */
  originalQuery?: string;
  /** `offer` stores answer-first alternatives that may be accepted on the next turn. */
  mode?: PendingClarificationMode;
  candidates: ClarificationCandidate[];
  askedEventId?: string;
  status: PendingClarificationStatus;
  expiresAt: string | Date;
}

export type ClarificationClearOutcome = "resolved" | "declined" | "expired";

/** Durable port for the at-most-one pending clarification in a conversation. */
export interface ConversationClarificationStore {
  loadPending(input: { sessionId: string }): Promise<PendingClarification | null>;
  save(pending: PendingClarification): Promise<void>;
  clear(input: { sessionId: string; outcome?: ClarificationClearOutcome }): Promise<void>;
}

/**
 * Optional read-side companion for clarification stores. It lives with the store
 * port because hosts own persistence/indexing; the engine only consumes the
 * capability when a host provides it.
 */
export interface RecentClarificationReader {
  loadRecent(input: { sessionId: string }): Promise<PendingClarification | null>;
}

/** How a reply to an `offer` row resolved: took an offered option, said no, or moved on. */
export type ClarificationOfferMappingOutcome = "accepted" | "declined" | "ignored";

export type ClarificationReplyMapping =
  | { kind: "chosen"; id: string }
  | { kind: "declined" }
  | { kind: "unrelated" };

export interface ClarificationReplyMapInput {
  candidates: ClarificationCandidate[];
  turn: TurnContext;
  /**
   * Pending clarification mode. Omitted callers keep the historical blocking
   * clarification behavior; `offer` asks clarifiers to accept only selection-only
   * replies and treat substantive follow-up requests as unrelated.
   */
  mode?: PendingClarificationMode;
  /** The surface that saved the pending row, so a clarifier can word each surface's offer. */
  source?: string;
}

/** LLM-backed clarifier port for phrasing questions and mapping free-text replies. */
export interface ConversationClarifier {
  phraseQuestion(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<string>;
  mapReply(input: ClarificationReplyMapInput): Promise<ClarificationReplyMapping>;
}
