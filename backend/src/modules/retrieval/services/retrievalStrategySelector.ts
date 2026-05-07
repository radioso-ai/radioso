import { capabilityNames } from "../../../shared/domain/capabilityPolicy.js";
import type { SkillCallerSurface, SkillDiagnostic } from "../../skills/public.js";
import type {
  ContinuityDecision,
  RetrievalAnswerStrategy,
  RetrievalQueryShape,
  RerankStatus,
  RetrievalAnswerStrategySelection,
  RewrittenRetrievalQuery,
} from "../domain/retrievalPipelineTypes.js";

export type { RetrievalAnswerStrategySelection } from "../domain/retrievalPipelineTypes.js";

export interface RetrievalStrategySelectorInput {
  query: string;
  rewrittenQuery?: RewrittenRetrievalQuery;
  continuityDecision?: ContinuityDecision;
  historyMessageCount?: number;
}

export interface RetrievalAnswerSkillDiagnosticInput {
  callerSurface: SkillCallerSurface;
  rerankStatus: RerankStatus;
  candidateCounts: {
    semantic: number;
    lexical: number;
    merged: number;
    final: number;
  };
  fallbackApplied: boolean;
  supportStatus: "supported" | "unsupported" | "not_checked" | "not_applicable";
}

const isFollowUp = (input: RetrievalStrategySelectorInput): boolean => {
  const turnKind = input.rewrittenQuery?.structuredResult?.turnKind;
  if ((input.historyMessageCount ?? 0) === 0) {
    return false;
  }
  return (
    turnKind === "referential_followup" ||
    turnKind === "referential_relation" ||
    turnKind === "comparative"
  );
};

const strategyForQueryShape = (queryShape?: RetrievalQueryShape): RetrievalAnswerStrategy | undefined => {
  switch (queryShape) {
    case "definition_lookup":
    case "event_date_lookup":
    case "policy_answer":
    case "exploratory_summary":
    case "default_hybrid":
      return queryShape;
    case "follow_up_grounding":
    case "general_grounding":
    case undefined:
      return undefined;
  }
};

export const selectRetrievalAnswerStrategy = (
  input: RetrievalStrategySelectorInput,
): RetrievalAnswerStrategySelection => {
  if (isFollowUp(input)) {
    return {
      strategy: "follow_up_grounding",
      queryShape: "follow_up_grounding",
      selectionMode: "deterministic",
      selectionReason: "Conversation continuity metadata indicates this turn depends on prior grounded context.",
      selectionConfidence: input.rewrittenQuery?.structuredResult?.confidence,
    };
  }

  const queryShape = input.rewrittenQuery?.structuredResult?.queryShape;
  const selectedStrategy = strategyForQueryShape(queryShape);
  if (selectedStrategy) {
    return {
      strategy: selectedStrategy,
      queryShape: queryShape ?? selectedStrategy,
      selectionMode: "probabilistic",
      selectionReason: "Structured query interpretation selected the retrieval strategy without language-specific keyword rules.",
      selectionConfidence: input.rewrittenQuery?.structuredResult?.confidence,
    };
  }

  return {
    strategy: "default_hybrid",
    queryShape: queryShape ?? "general_grounding",
    selectionMode: "deterministic",
    selectionReason: "No specialized retrieval shape was provided; using the default hybrid retrieval path.",
  };
};

export const buildRetrievalAnswerSkillDiagnostic = (
  selection: RetrievalAnswerStrategySelection,
  input: RetrievalAnswerSkillDiagnosticInput,
): SkillDiagnostic => ({
  skillName: capabilityNames.retrieval.answer,
  strategy: selection.strategy,
  selectionMode: selection.selectionMode,
  selectionReason: selection.selectionReason,
  selectionConfidence: selection.selectionConfidence,
  callerSurface: input.callerSurface,
  capabilityChecks: [
    {
      capability: capabilityNames.retrieval.answer,
      allowed: true,
    },
  ],
  parameters: {
    rerankStatus: input.rerankStatus,
    candidateCounts: input.candidateCounts,
  },
  fallback: input.fallbackApplied
    ? {
        used: true,
        reason: "retrieval_fallback_applied",
      }
    : {
        used: false,
      },
  outcome: "success",
  evidence: {
    queryShape: selection.queryShape,
    retrievalStrategy: selection.strategy,
    candidateSourceSummary: input.candidateCounts,
    ranking: {
      rerankStatus: input.rerankStatus,
      lexicalPreferred: selection.strategy === "definition_lookup",
    },
    evidenceStatus: input.candidateCounts.final > 0 ? "found" : "missing",
    supportStatus: input.supportStatus,
  },
});
