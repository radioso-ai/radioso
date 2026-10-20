import type { ChatAnswerCoverageAssessment } from "../../chat/contracts/index.js";
import type { EvalRunObservedOutput } from "../domain/types.js";

/**
 * What a review turn shows besides the shared observed output. A review turn returns its
 * reply as a draft and carries no turn trace, so its coverage verdict comes from the turn's
 * own facts, and the runner counts the replies the conversation gained while it ran.
 */
interface ReviewTurnObservation {
  /** The coverage record the review facts carried; null when the turn recorded none. */
  answerCoverage: Pick<ChatAnswerCoverageAssessment, "availability" | "coverage"> | null;
  /** Assistant messages written to the conversation during the turn. */
  persistedAssistantMessageCount: number;
}

/**
 * What a voice turn shows besides the shared observed output: the real turn policy's structural
 * signals, read from its `VoiceTurnEvent` stream (`bridged`, `outcomeKind`) and timed by the
 * runner around that stream (`firstSpeechMs`), by `evalRunnerAdapter.ts`'s `observeVoiceTurn`.
 * `turnLimitReached` has no event of its own on that stream — the policy reports it only to its
 * metrics observer — so it is read by comparing the turn's whole spoken text against the
 * fixture's configured fallback line: the only way the limit's fallback speech can be told apart
 * from a real answer once both are just "speech" events.
 */
export interface VoiceTurnObservation {
  bridged: boolean;
  turnLimitReached: boolean;
  outcomeKind: "continue" | "callback_requested" | null;
  /** Elapsed ms to the turn's first speech (the reply's or the fallback's); null when none was spoken. */
  firstSpeechMs: number | null;
}

/** The output the suite scores: a live turn's observed output, or a review/voice turn's with its observation. */
export interface ConversationQualityObservedOutput extends EvalRunObservedOutput {
  reviewTurn?: ReviewTurnObservation;
  voiceTurn?: VoiceTurnObservation;
}
