import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsRecord } from "../../settings/domain/retrievalSettings.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type {
  ConversationContextWindow,
  ResponseIntent,
  RetrievalSubquery,
  ResponseLanguagePolicy,
  RewrittenRetrievalQuery,
  TriggerAnalysisResult,
  TriggerBackoffDecision,
} from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";
import type { PromptBuildResult } from "./promptBuilder.js";

export interface RetrievalPipelineRequest {
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  responseIdentity?: ResponseIdentity | null;
  responseBehaviorEnabled?: boolean;
  responseLanguagePolicy?: ResponseLanguagePolicy;
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
  responseIntent: ResponseIntent;
  activeQuery: string;
  activeParsedQuery: ParsedQueryInterpretation;
  activeSemanticQuery: string;
  activeRetrievalSubqueries: RetrievalSubquery[];
  triggerAnalysis: TriggerAnalysisResult;
  promptHistory: MessageRecord[];
  continuityDecision: "unchanged" | "updated" | "unresolved" | "rejected";
}

export interface RetrievalBranchResult {
  subqueryId: string;
  label: string;
  semanticQuery: string;
  lexicalQuery: string;
  reason?: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  source: "original" | "rewritten";
  semanticContexts: RetrievedChunk[];
  lexicalContexts: RetrievedChunk[];
}

export interface CandidateRetrievalStageResult extends QueryInterpretationStageResult {
  activeEmbedding: number[];
  activeEmbeddingDurationMs: number;
  originalContexts: RetrievedChunk[];
  rewrittenContexts: RetrievedChunk[];
  lexicalContexts: RetrievedChunk[];
  retrievalBranches: RetrievalBranchResult[];
  vectorFallbackApplied: boolean;
}

export interface CandidatePreparationStageResult extends CandidateRetrievalStageResult {
  normalizedCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  mergedCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  scoredCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  appliedConstraints: AppliedConstraint[];
  candidateFallbackApplied: boolean;
  triggerBackoff: TriggerBackoffDecision;
}

export interface ContextSelectionStageResult extends CandidatePreparationStageResult {
  rerankedContexts: import("../domain/retrievalPipelineTypes.js").RerankedCandidate[];
  rerankStatus: import("../domain/retrievalPipelineTypes.js").RerankStatus;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
}

export interface PromptAssemblyStageResult extends ContextSelectionStageResult {
  systemPrompt: string;
  prompt: string;
  citations: PromptBuildResult["citations"];
  responseSettings: {
    citationDisplayEnabled: boolean;
    conversationMode: RetrievalSettingsRecord["conversationMode"];
    suggestedQuestionsEnabled: RetrievalSettingsRecord["suggestedQuestionsEnabled"];
    suggestedQuestionsCount: RetrievalSettingsRecord["suggestedQuestionsCount"];
    customInstruction?: RetrievalSettingsRecord["customInstruction"];
    responseLanguagePolicy?: ResponseLanguagePolicy;
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
  execute(input: PromptAssemblyStageResult): Promise<import("../domain/retrievalPipelineTypes.js").RetrievalExecutionDiagnostics>;
}
