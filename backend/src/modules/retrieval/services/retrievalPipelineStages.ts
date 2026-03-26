import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsRecord } from "../../settings/domain/retrievalSettings.js";
import type { ConversationContextWindow, RewrittenRetrievalQuery } from "../domain/retrievalPipelineTypes.js";
import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";
import type { PromptBuildResult } from "./promptBuilder.js";

export interface RetrievalPipelineRequest {
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  rewriteCarryForwardLiterals?: string[];
  metadataFilter?: Record<string, unknown>;
}

export interface RetrievalContextStageResult {
  request: RetrievalPipelineRequest;
  settings: RetrievalSettingsRecord;
  contextWindow: ConversationContextWindow;
}

export interface QueryInterpretationStageResult extends RetrievalContextStageResult {
  originalParsedQuery: ParsedQueryInterpretation;
  originalPreparedQuery: ParsedQueryInterpretation;
  rewrittenQuery: RewrittenRetrievalQuery;
  activeQuery: string;
  activeParsedQuery: ParsedQueryInterpretation;
  activeSemanticQuery: string;
  continuityDecision: "unchanged" | "updated" | "unresolved" | "rejected";
}

export interface CandidateRetrievalStageResult extends QueryInterpretationStageResult {
  activeEmbedding: number[];
  originalContexts: RetrievedChunk[];
  rewrittenContexts: RetrievedChunk[];
  lexicalContexts: RetrievedChunk[];
  vectorFallbackApplied: boolean;
}

export interface CandidatePreparationStageResult extends CandidateRetrievalStageResult {
  normalizedCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  mergedCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  scoredCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  appliedConstraints: import("../domain/structuredAttributes.js").AppliedConstraint[];
  candidateFallbackApplied: boolean;
}

export interface ContextSelectionStageResult extends CandidatePreparationStageResult {
  rerankedContexts: import("../domain/retrievalPipelineTypes.js").RerankedCandidate[];
  rerankStatus: import("../domain/retrievalPipelineTypes.js").RerankStatus;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
}

export interface PromptAssemblyStageResult extends ContextSelectionStageResult {
  prompt: string;
  citations: PromptBuildResult["citations"];
  responseSettings: {
    warmthLevel: number;
    citationDisplayEnabled: boolean;
  };
}

export interface QueryInterpretationStage {
  execute(input: RetrievalContextStageResult): Promise<QueryInterpretationStageResult>;
}

export interface RetrievalContextStage {
  execute(input: RetrievalPipelineRequest): Promise<RetrievalContextStageResult>;
}

export interface CandidateRetrievalStage {
  execute(input: QueryInterpretationStageResult): Promise<CandidateRetrievalStageResult>;
}

export interface CandidatePreparationStage {
  execute(input: CandidateRetrievalStageResult): Promise<CandidatePreparationStageResult>;
}

export interface ContextSelectionStage {
  execute(input: CandidatePreparationStageResult): Promise<ContextSelectionStageResult>;
}

export interface PromptAssemblyStage {
  execute(input: ContextSelectionStageResult): PromptAssemblyStageResult;
}

export interface RetrievalDiagnosticsStage {
  execute(input: PromptAssemblyStageResult): import("../domain/retrievalPipelineTypes.js").RetrievalExecutionDiagnostics;
}

export const stripEnabledConstraintLiterals = (
  query: string,
  parsedQuery: ParsedQueryInterpretation,
  enabledSignalKeys: Set<string>,
): string => {
  const stripped = parsedQuery.constraints
    .filter((constraint) => enabledSignalKeys.has(constraint.signalKey))
    .reduce((value, constraint) => {
      if (!constraint.sourceText) {
        return value;
      }

      const escaped = constraint.sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return value.replace(new RegExp(`\\b${escaped}\\b`, "i"), " ");
    }, query)
    .replace(/\s+/g, " ")
    .trim();

  return stripped || query;
};

export const mergeParsedQueries = (
  originalParsedQuery: ParsedQueryInterpretation,
  rewrittenParsedQuery: ParsedQueryInterpretation,
): ParsedQueryInterpretation => {
  const seenConstraintKeys = new Set<string>();
  const constraints = [...originalParsedQuery.constraints, ...rewrittenParsedQuery.constraints].filter((constraint) => {
    const key = JSON.stringify({
      signalKey: constraint.signalKey,
      operator: constraint.operator,
      summary: constraint.summary,
      value: constraint.value,
    });
    if (seenConstraintKeys.has(key)) {
      return false;
    }
    seenConstraintKeys.add(key);
    return true;
  });

  return {
    semanticQuery: rewrittenParsedQuery.semanticQuery,
    lexicalQuery: rewrittenParsedQuery.lexicalQuery,
    constraints,
  };
};
