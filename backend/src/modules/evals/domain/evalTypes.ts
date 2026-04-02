import type { AssistantTurnOutcome } from "../../chat/services/answerSupportValidationTypes.js";
import type { AnswerSegment, ChatCitation } from "../../chat/services/answerPresentationService.js";
import type { RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";

export type EvalDatasetStatus = "active" | "archived";
export type EvalCaseSourceType = "manual" | "conversation_import";
export type EvalExpectedRefusalBehavior = "refusal" | "answer";
export type EvalDimensionVerdict = "pass" | "fail" | "unscored";
export type EvalCaseResultStatus = "pass" | "fail" | "skipped" | "invalid";
export type EvalRunComparisonOutcome = "improved" | "regressed" | "unchanged" | "unscored";

export interface EvalCaseConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface EvalCaseExpectations {
  expectedDocumentIds?: string[];
  expectedCitationTitles?: string[];
  expectedRefusalBehavior?: EvalExpectedRefusalBehavior;
  expectedAnswerOutcome?: AssistantTurnOutcome;
  requiredPhrases?: string[];
  forbiddenPhrases?: string[];
  latencyBudgetMs?: number;
}

export interface EvalDatasetRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: EvalDatasetStatus;
  createdByAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvalCaseRecord {
  id: string;
  datasetId: string;
  workspaceId: string;
  title: string;
  sourceType: EvalCaseSourceType;
  query: string;
  conversationContext: EvalCaseConversationMessage[];
  expectations: EvalCaseExpectations;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EvalDatasetSummary extends EvalDatasetRecord {
  caseCount: number;
  runCount: number;
  lastRunAt: string | null;
}

export interface EvalImportDraft {
  title: string;
  query: string;
  conversationContext: EvalCaseConversationMessage[];
  sourceType: EvalCaseSourceType;
  provenance: Record<string, unknown>;
  seededExpectations: EvalCaseExpectations;
  unavailable: string[];
}

export interface EvalCaseCreateInput {
  title: string;
  sourceType?: EvalCaseSourceType;
  query: string;
  conversationContext?: EvalCaseConversationMessage[];
  expectations?: EvalCaseExpectations;
  provenance?: Record<string, unknown>;
}

export interface EvalDatasetDetail extends EvalDatasetRecord {
  cases: EvalCaseRecord[];
  runs: EvalRunRecord[];
}

export interface EvalDimensionResult {
  verdict: EvalDimensionVerdict;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
}

export interface EvalCaseScore {
  documentMatch: EvalDimensionResult;
  citationMatch: EvalDimensionResult;
  refusalMatch: EvalDimensionResult;
  answerOutcomeMatch: EvalDimensionResult;
  answerContainsMatch: EvalDimensionResult;
  latencyMatch: EvalDimensionResult;
  overallVerdict: Exclude<EvalCaseResultStatus, "skipped" | "invalid">;
  reasons: string[];
}

export interface EvalReplayDiagnostics {
  retrievalInfo: RetrievalInfo;
  retrievalTrace?: RetrievalTrace;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  answerOutcome: AssistantTurnOutcome;
  answerSupportPolicy?: string;
  answer: string;
  latencyMs: number;
}

export interface EvalCaseResultRecord {
  caseId: string;
  status: EvalCaseResultStatus;
  score: EvalCaseScore;
  diagnostics: EvalReplayDiagnostics;
  comparisonOutcome?: EvalRunComparisonOutcome;
  comparisonReasons?: string[];
}

export interface EvalRunSummary {
  totalCases: number;
  passCount: number;
  failCount: number;
  skippedCount: number;
  invalidCount: number;
  improvementCount: number;
  regressionCount: number;
  unchangedCount: number;
}

export interface EvalRunRecord {
  id: string;
  datasetId: string;
  workspaceId: string;
  label: string | null;
  baselineRunId: string | null;
  createdByAccountId: string | null;
  runMetadata: Record<string, unknown>;
  summary: EvalRunSummary;
  results: EvalCaseResultRecord[];
  startedAt: string;
  completedAt: string;
}

export interface EvalCaseComparison {
  caseId: string;
  title: string;
  outcome: EvalRunComparisonOutcome;
  reasons: string[];
  baselineStatus?: EvalCaseResultStatus;
  candidateStatus?: EvalCaseResultStatus;
}

export interface EvalRunComparison {
  baselineRunId: string;
  candidateRunId: string;
  regressions: number;
  improvements: number;
  unchanged: number;
  unscored: number;
  cases: EvalCaseComparison[];
}
