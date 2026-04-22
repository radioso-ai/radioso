import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsRecord } from "../../settings/domain/retrievalSettings.js";
import type { AssistantIdentityPromptInput } from "../../settings/domain/assistantBootstrapSettings.js";
import type {
  ConversationContextWindow,
  RetrievalSubquery,
  ResponseLanguagePolicy,
  RewrittenRetrievalQuery,
} from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";
import type { PromptBuildResult } from "./promptBuilder.js";

export interface RetrievalPipelineRequest {
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  assistantIdentity?: AssistantIdentityPromptInput | null;
  responseLanguagePolicy?: ResponseLanguagePolicy;
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
  activeRetrievalSubqueries: RetrievalSubquery[];
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
    citationDisplayEnabled: boolean;
    answerSupportPolicy: RetrievalSettingsRecord["answerSupportPolicy"];
    conversationMode: RetrievalSettingsRecord["conversationMode"];
    suggestedQuestionsEnabled: RetrievalSettingsRecord["suggestedQuestionsEnabled"];
    suggestedQuestionsCount: RetrievalSettingsRecord["suggestedQuestionsCount"];
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
