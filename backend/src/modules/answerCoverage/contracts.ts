import { z } from "zod";

import type {
  AnswerCoverage,
  AnswerCoverageAssessment,
  AnswerCoverageCriteria,
  AnswerCoverageReason,
} from "@radioso/conversation-contract";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type { JsonSchemaResponseFormat } from "../../shared/infra/llm/providerTypes.js";

export type {
  AnswerCoverage,
  AnswerCoverageAssessment,
  AnswerCoverageCriteria,
} from "@radioso/conversation-contract";

const answerCoverageSchema = z.enum(["answered", "partial", "unanswered", "unclear"]);

const answerCoverageReasonSchema = z.enum([
  "sufficient_evidence",
  "insufficient_evidence",
  "conflicting_evidence",
  "ambiguous_request",
  "intentional_scope_boundary",
]);

/**
 * The eight-value classification a coverage judge (the pre-compose assessor today,
 * the answer envelope head after #1260) emits. Shared here so both a producer and
 * the envelope schema/head reader classify against exactly one table.
 */
export const classifications = {
  answered_sufficient_evidence: { coverage: "answered", reason: "sufficient_evidence" },
  partial_insufficient_evidence: { coverage: "partial", reason: "insufficient_evidence" },
  partial_conflicting_evidence: { coverage: "partial", reason: "conflicting_evidence" },
  partial_intentional_scope_boundary: { coverage: "partial", reason: "intentional_scope_boundary" },
  unanswered_insufficient_evidence: { coverage: "unanswered", reason: "insufficient_evidence" },
  unanswered_conflicting_evidence: { coverage: "unanswered", reason: "conflicting_evidence" },
  unanswered_intentional_scope_boundary: { coverage: "unanswered", reason: "intentional_scope_boundary" },
  unclear_ambiguous_request: { coverage: "unclear", reason: "ambiguous_request" },
} as const satisfies Record<string, { coverage: AnswerCoverage; reason: AnswerCoverageReason }>;

export type AnswerCoverageClassification = keyof typeof classifications;

export const classificationValues = Object.keys(classifications) as [
  AnswerCoverageClassification,
  ...AnswerCoverageClassification[],
];

/** Classification taxonomy version, carried on every assessed record. */
export const ANSWER_COVERAGE_SCHEMA_VERSION = 1;

/** Bound shared by the assessor's `requestFocus` field and the envelope head's. */
export const REQUEST_FOCUS_MAX_LENGTH = 600;


const compatibleReasonsByCoverage: Record<AnswerCoverage, readonly AnswerCoverageReason[]> = {
  answered: ["sufficient_evidence"],
  partial: ["insufficient_evidence", "conflicting_evidence", "intentional_scope_boundary"],
  unanswered: ["insufficient_evidence", "conflicting_evidence", "intentional_scope_boundary"],
  unclear: ["ambiguous_request"],
};

/** Validation shared by directive and routine authoring; absent stays legacy-compatible. */
export const answerCoverageCriteriaSchema: z.ZodType<AnswerCoverageCriteria> = z.object({
  coverage: z.array(answerCoverageSchema).min(1).refine(
    (coverage) => new Set(coverage).size === coverage.length,
    "Coverage criteria cannot repeat a coverage value",
  ),
  reasons: z.array(answerCoverageReasonSchema).min(1).refine(
    (reasons) => new Set(reasons).size === reasons.length,
    "Coverage criteria cannot repeat a reason",
  ).optional(),
}).strict().superRefine((criteria, ctx) => {
  for (const reason of criteria.reasons ?? []) {
    const compatible = criteria.coverage.some((coverage) => compatibleReasonsByCoverage[coverage].includes(reason));
    if (!compatible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasons"],
        message: `Reason ${reason} is incompatible with selected coverage`,
      });
    }
  }
});

export interface AnswerCoverageInferencePort {
  complete(input: {
    operation: ModelCallUsageContext;
    prompt: string;
    maxOutputTokens: number;
    responseFormat: JsonSchemaResponseFormat;
    signal?: AbortSignal;
  }): Promise<{ text?: string }>;
}

export type AnswerCoverageRecord = AnswerCoverageAssessment & {
  id: string;
  workspaceId: string;
  conversationId: string;
  requestMessageId: string;
  originatingTurnId: string;
  contextualizedRequest: string;
  /** Present only after the exact assistant turn that evaluated this request commits. */
  assistantMessageId?: string;
  schemaVersion: number;
  /** Absent means evaluation was never completed; evaluated with zero reactions means no match. */
  interactionEvaluationState?: "evaluated";
  assessedAt: Date;
  createdAt: Date;
};

export interface AnswerCoverageRepositoryPort {
  saveAssessment(input: {
    workspaceId: string;
    conversationId: string;
    requestMessageId: string;
    originatingTurnId: string;
    contextualizedRequest: string;
    assessment: AnswerCoverageAssessment;
  }): Promise<AnswerCoverageRecord>;
  findByRequestMessageId(input: { workspaceId: string; requestMessageId: string }): Promise<AnswerCoverageRecord | null>;
  listByRequestMessageIds(input: { workspaceId: string; requestMessageIds: readonly string[] }): Promise<Map<string, AnswerCoverageRecord>>;
  markInteractionEvaluated(input: { workspaceId: string; assessmentId: string }): Promise<void>;
}

type AnswerCoverageReactionDecision = "matched" | "applied" | "offered" | "activated" | "skipped" | "suppressed";

export interface AnswerCoverageReactionTrace {
  id: string;
  assessmentId: string;
  workspaceId: string;
  conversationId: string;
  reactionKey: string;
  directiveId?: string;
  routineId?: string;
  /** Durable identity of the concrete routine run, never derived from reactionKey. */
  routineExecutionId?: string;
  /** Existing user message that triggered this evaluated reaction. */
  targetMessageId: string;
  evaluationState: "evaluated" | "not_applicable" | "suppressed";
  evaluationIndex: number;
  decision: AnswerCoverageReactionDecision;
  reasonCode: string;
  createdAt: Date;
}

export interface AnswerCoverageReactionRepositoryPort {
  recordReaction(input: Omit<AnswerCoverageReactionTrace, "id" | "createdAt">): Promise<AnswerCoverageReactionTrace>;
  listByAssessmentId(input: { workspaceId: string; assessmentId: string }): Promise<AnswerCoverageReactionTrace[]>;
  /**
   * Read-side history/debug projection needs every reaction for a page of
   * assessments. Keep that projection bounded rather than issuing one query per
   * assessment.
   */
  listByAssessmentIds(input: {
    workspaceId: string;
    assessmentIds: readonly string[];
  }): Promise<Map<string, AnswerCoverageReactionTrace[]>>;
}
