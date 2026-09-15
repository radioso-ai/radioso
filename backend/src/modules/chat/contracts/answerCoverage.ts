import type {
  AnswerCoverage,
  AnswerCoverageAssessment as SharedAnswerCoverageAssessment,
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
} from "../../answerCoverage/public.js";
import type {
  AnswerCoverageReason,
  ConversationCoverageVerdictSink,
} from "@radioso/conversation-contract";

/**
 * `AnswerCoverageAssessment` carries its `producer` marker (#1260, FR-017)
 * directly on `@radioso/conversation-contract` now that the cross-package
 * coverage verdict port exists. Re-exported under the chat module's own name
 * because every chat-local caller already imports it from here.
 */
export type AnswerCoverageAssessment = SharedAnswerCoverageAssessment;

/**
 * The one call a retrieval-style skill makes to hand its coverage verdict to the
 * host before releasing any answer text (#1260, FR-005). The skill knows nothing
 * about what the host does with the verdict — routines, directives, persistence —
 * only whether to proceed or yield the turn. Alias of the cross-package
 * `ConversationCoverageVerdictSink` the engine constructs, kept under this
 * chat-local name because every chat-local caller already imports it from here.
 */
export type RetrievalCoverageVerdictSink = ConversationCoverageVerdictSink;

export interface ChatAnswerCoverageAssessment {
  availability: AnswerCoverageRecord["availability"];
  coverage?: AnswerCoverage;
  reason?: AnswerCoverageReason;
  contextualizedRequest?: string;
  unresolvedRequest?: string;
  originatingTurnId: string;
  originatingRequestId: string;
  schemaVersion?: number;
  assessedAt?: string;
}

export interface ChatAnswerCoverageInteractionDecision {
  assessmentRequestId: string;
  target: "directive" | "routine";
  targetId?: string;
  decision: AnswerCoverageReactionTrace["decision"];
  reasonCode: string;
  routineExecutionId?: string;
  targetMessageId: string;
}

export interface ChatAnswerCoverageInteractionTrace {
  state: "not_evaluated" | "evaluated";
  consumedAssessment?: Pick<Extract<AnswerCoverageRecord, { availability: "assessed" }>, "coverage" | "reason">;
  decisions: ChatAnswerCoverageInteractionDecision[];
}
