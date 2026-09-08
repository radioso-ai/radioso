import type {
  AnswerCoverage,
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
} from "../../answerCoverage/public.js";
import type { AnswerCoverageReason } from "@radioso/conversation-contract";

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
