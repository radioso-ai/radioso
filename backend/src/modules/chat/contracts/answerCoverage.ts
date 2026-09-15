import type {
  AnswerCoverage,
  AnswerCoverageAssessment as SharedAnswerCoverageAssessment,
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
} from "../../answerCoverage/public.js";
import type { AnswerCoverageReason } from "@radioso/conversation-contract";

/**
 * Distinguishes which stage produced an assessment (#1260): the model's own
 * envelope head, this turn's deterministic zero-evidence fallback, or the
 * pre-compose assessor (kept running through the shadow window). Belongs on
 * `@radioso/conversation-contract`'s `AnswerCoverageAssessment` from the slice
 * that adds the real cross-package coverage verdict port; until then this
 * backend-local widening is what the sink and the head mapping carry.
 */
type AnswerCoverageProducer = "answer_head" | "deterministic" | "assessor";

export type AnswerCoverageAssessment = SharedAnswerCoverageAssessment & {
  producer: AnswerCoverageProducer;
};

/**
 * The one call a retrieval-style skill makes to hand its coverage verdict to the
 * host before releasing any answer text (#1260, FR-005). The skill knows nothing
 * about what the host does with the verdict — routines, directives, persistence —
 * only whether to proceed or yield the turn. `packages/conversation-contract`
 * gains the real cross-package `ConversationCoverageVerdictSink` port in a later
 * slice; this backend-local port is what `TurnRenderContext` carries until then.
 */
export interface RetrievalCoverageVerdictSink {
  report(input: { assessment: AnswerCoverageAssessment }): Promise<{ decision: "proceed" | "yield_turn" }>;
}

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
