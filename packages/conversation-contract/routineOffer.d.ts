// A routine's start mode, and the offer an Offer-first routine makes instead of starting.
import type { PendingClarification } from "./clarification.js";
import type { ConversationTraceStage } from "./index.js";

/**
 * How a ranked match starts its routine. `automatic` starts it on the match. `offer` starts it
 * only when the visitor directly asked for what it does; otherwise the turn is answered and the
 * answer offers to start it. Absent reads as `automatic`.
 */
export type RoutineStartMode = "automatic" | "offer";

/**
 * The routine a turn's answer offers to start: its name and what it is for, and the pending row
 * that lets the next turn accept it. The host saves `pending` and records the offer only once the
 * reply that ends with the offer is the reply the visitor sees.
 */
export interface RoutineStartOffer {
  routineId: string;
  label: string;
  description?: string;
  pending: PendingClarification;
}

/**
 * What the routine pass decided on a turn it did not claim: the clarification stages the turn's
 * trace records (an offer, an offer held back because the conversation already had it, a reply
 * to an earlier offer) and, when the turn offers a routine, the offer its answer ends with.
 * `sessionId` and `inputEventId` name the turn, as they do for a {@link RoutineTurnYield}.
 */
export interface RoutineActivationNotice {
  sessionId: string;
  inputEventId?: string;
  stages: ConversationTraceStage[];
  offer?: RoutineStartOffer;
}

/** Told when `attemptRoutine` returns null with stages or an offer for the turn to record. */
export interface ConversationRoutineActivationSink {
  noticed(notice: RoutineActivationNotice): void;
}

/**
 * The routines a conversation has been offered. The memory outlives the pending offer: a routine
 * is offered at most once per conversation, and a direct request still starts it.
 */
export interface ConversationRoutineOfferMemory {
  loadOffered(input: { sessionId: string }): Promise<readonly string[]>;
}
