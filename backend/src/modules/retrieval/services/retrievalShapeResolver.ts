import { capabilityNames } from "../../../shared/domain/capabilityPolicy.js";
import {
  retrievalAnswerSkillDefinition,
  SkillRunResolver,
  type ResolvedSkillRun,
  type SkillCallerSurface,
  type SkillDiagnostic,
} from "../../skills/public.js";
import type {
  ContinuityDecision,
  RetrievalAnswerShapeName,
  RetrievalAnswerShapeSelection,
  RetrievalQueryShape,
  RerankStatus,
  RewrittenRetrievalQuery,
} from "../domain/retrievalPipelineTypes.js";

export type { RetrievalAnswerShapeSelection } from "../domain/retrievalPipelineTypes.js";

export interface RetrievalShapeResolverInput {
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

const resolver = new SkillRunResolver();
const retrievalShapeNames = new Set(retrievalAnswerSkillDefinition.shapes?.map((shape) => shape.name) ?? []);

const isFollowUp = (input: RetrievalShapeResolverInput): boolean => {
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

const shapeForQueryShape = (queryShape?: RetrievalQueryShape): RetrievalAnswerShapeName | undefined => {
  if (!queryShape || queryShape === "general_grounding" || queryShape === "follow_up_grounding") {
    return undefined;
  }
  return retrievalShapeNames.has(queryShape) ? queryShape : undefined;
};

const resolveSkillRun = (shapeName: RetrievalAnswerShapeName): ResolvedSkillRun =>
  resolver.resolve({
    skill: retrievalAnswerSkillDefinition,
    shapeName,
    fallbackShapeName: "default_hybrid",
  });

export const selectRetrievalAnswerShape = (
  input: RetrievalShapeResolverInput,
): RetrievalAnswerShapeSelection => {
  if (isFollowUp(input)) {
    return {
      shapeName: "follow_up_grounding",
      queryShape: "follow_up_grounding",
      selectionMode: "deterministic",
      selectionReason: "Conversation continuity metadata indicates this turn depends on prior grounded context.",
      selectionConfidence: input.rewrittenQuery?.structuredResult?.confidence,
      resolvedRun: resolveSkillRun("follow_up_grounding"),
    };
  }

  const queryShape = input.rewrittenQuery?.structuredResult?.queryShape;
  const selectedShape = shapeForQueryShape(queryShape);
  if (selectedShape) {
    return {
      shapeName: selectedShape,
      queryShape: queryShape ?? selectedShape,
      selectionMode: "probabilistic",
      selectionReason: "Structured query interpretation selected the retrieval shape without language-specific keyword rules.",
      selectionConfidence: input.rewrittenQuery?.structuredResult?.confidence,
      resolvedRun: resolveSkillRun(selectedShape),
    };
  }

  return {
    shapeName: "default_hybrid",
    queryShape: queryShape ?? "general_grounding",
    selectionMode: "deterministic",
    selectionReason: "No specialized retrieval shape was provided; using the default hybrid retrieval path.",
    resolvedRun: resolveSkillRun("default_hybrid"),
  };
};

export const getContextSelectionClauses = (
  run: ResolvedSkillRun | undefined,
): { ranking: { rerankMode: string; lexicalBias: string } } => {
  const clauses = run?.resolvedSteps.find((step) => step.name === "context_selection")?.clauses;
  const ranking = clauses?.ranking && typeof clauses.ranking === "object"
    ? clauses.ranking as { rerankMode?: unknown; lexicalBias?: unknown }
    : {};
  return {
    ranking: {
      rerankMode: typeof ranking.rerankMode === "string" ? ranking.rerankMode : "settings_default",
      lexicalBias: typeof ranking.lexicalBias === "string" ? ranking.lexicalBias : "normal",
    },
  };
};

export const summarizeResolvedSteps = (run: ResolvedSkillRun | undefined): Array<Record<string, unknown>> =>
  run?.resolvedSteps.map((step) => ({
    name: step.name,
    kind: step.kind,
    overrideApplied: step.overrideApplied,
    appliedOverride: step.appliedOverride,
  })) ?? [];

export const buildRetrievalAnswerSkillDiagnostic = (
  selection: RetrievalAnswerShapeSelection,
  input: RetrievalAnswerSkillDiagnosticInput,
): SkillDiagnostic => ({
  skillName: capabilityNames.retrieval.answer,
  shapeName: selection.shapeName,
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
    retrievalShape: selection.shapeName,
    candidateSourceSummary: input.candidateCounts,
    ranking: {
      rerankStatus: input.rerankStatus,
      lexicalPreferred: getContextSelectionClauses(selection.resolvedRun).ranking.lexicalBias === "preferred",
    },
    resolvedSteps: summarizeResolvedSteps(selection.resolvedRun),
    evidenceStatus: input.candidateCounts.final > 0 ? "found" : "missing",
    supportStatus: input.supportStatus,
  },
});
