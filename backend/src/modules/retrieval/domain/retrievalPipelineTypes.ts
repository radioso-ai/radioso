import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ResolvedSkillRun, SkillDiagnostic } from "../../skills/public.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "./queryConstraintTypes.js";
import type { RetrievedChunk } from "./vectorSearch.js";

export {
  resolveRetrievalSourceFilter,
  type RetrievalSourceFilter,
  type RetrievalSourceScope,
} from "./retrievalSourceFilter.js";

export interface ConversationContextWindow {
  selectedMessages: MessageRecord[];
  truncated: boolean;
  selectionReason: string;
}

export interface RewriteContinuityState {
  activeSubject?: string;
  relatedEntities: string[];
  groundedTitles: string[];
}

export const REWRITE_STATUS = {
  SKIPPED: "skipped",
  APPLIED: "applied",
  FALLBACK: "fallback",
  REJECTED: "rejected",
} as const;

export type RewriteStatus = (typeof REWRITE_STATUS)[keyof typeof REWRITE_STATUS];

export const REWRITE_TURN_KIND = {
  FRESH_SUBJECT: "fresh_subject",
  REFERENTIAL_FOLLOWUP: "referential_followup",
  REFERENTIAL_RELATION: "referential_relation",
  EXPLICIT_RECENTER: "explicit_recenter",
  COMPARATIVE: "comparative",
  AMBIGUOUS: "ambiguous",
} as const;

export type RewriteTurnKind = (typeof REWRITE_TURN_KIND)[keyof typeof REWRITE_TURN_KIND];

export const RESPONSE_INTENT = {
  RETRIEVAL: "retrieval",
  SOCIAL_ONLY: "social_only",
  ASSISTANT_IDENTITY: "assistant_identity",
} as const;

export type ResponseIntent = (typeof RESPONSE_INTENT)[keyof typeof RESPONSE_INTENT];

export type ResponseLanguagePolicy = "match_user_question";

export type RetrievalAnswerShapeName =
  | "definition_lookup"
  | "event_date_lookup"
  | "policy_answer"
  | "exploratory_summary"
  | "follow_up_grounding"
  | "default_hybrid";

export type RetrievalQueryShape =
  | RetrievalAnswerShapeName
  | "general_grounding";

export interface StructuredRewriteResult {
  rewrittenQuery: string;
  semanticQuery?: string;
  lexicalQuery?: string;
  responseIntent?: ResponseIntent;
  intentTopic?: string;
  inScopeRequest?: string;
  outsideScopeRequest?: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  responseLanguage?: string;
  queryShape?: RetrievalQueryShape;
  retrievalSubqueries?: RetrievalSubquery[];
  turnKind: RewriteTurnKind;
  proposedActiveSubject?: string;
  relatedEntities: string[];
  unresolved: boolean;
  confidence: number;
}

export interface RetrievalSubquery {
  id: string;
  label: string;
  semanticQuery: string;
  lexicalQuery: string;
  reason?: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  lexicalPlan?: LexicalQueryPlan;
}

export interface LexicalSearchOption {
  label: string;
  lexicalQuery: string;
  phrases: string[];
  requiredTerms: string[];
  excludedTerms: string[];
}

export interface LexicalQueryPlan {
  options: LexicalSearchOption[];
}

export type ContinuityDecision = "unchanged" | "reused" | "updated" | "unresolved" | "rejected";

export type TriggerAnalysisStatus =
  | "skipped_not_configured"
  | "skipped_unavailable"
  | "skipped_non_retrieval"
  | "applied"
  | "fallback";

export interface TriggerRuleDecision {
  ruleId: string;
  matched: boolean;
  matchStrength: number;
  reason: string;
  triggerInstructionPreview: string;
}

export interface TriggerAnalysisResult {
  status: TriggerAnalysisStatus;
  consideredRules: TriggerRuleDecision[];
  matchedRuleIds: string[];
  unmatchedRuleIds: string[];
  matchCount: number;
  matcherVersion: string;
  failureReason?: string;
}

export interface TriggerBackoffDecision {
  applied: boolean;
  reason?: "empty_filtered_candidates" | "weak_filtered_support";
  relaxedRuleIds: string[];
  restoredCandidateCount?: number;
}

export interface RewrittenRetrievalQuery {
  originalQuery: string;
  rewrittenQuery: string;
  effectiveQuery: string;
  semanticQuery: string;
  lexicalQuery: string;
  responseIntent: ResponseIntent;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  retrievalSubqueries?: RetrievalSubquery[];
  rewriteApplied: boolean;
  retrievalEligible: boolean;
  status: RewriteStatus;
  confidence: number;
  structuredResult?: StructuredRewriteResult;
  intentFallbackApplied?: boolean;
  fallbackReason?: string;
  rejectionReason?: string;
}

export type RetrievalSource = "semantic_original" | "semantic_rewritten" | "lexical";

export interface RetrievedCandidate extends RetrievedChunk {
  retrievalSources: RetrievalSource[];
  retrievalText: string;
  semanticScore: number;
  lexicalScore: number;
  attributeMatchScore?: number;
}

export interface RerankedCandidate extends RetrievedCandidate {
  relevanceScore: number;
  rerankPosition: number;
}

export interface FinalPromptContext extends RerankedCandidate {
  promptPosition: number;
  estimatedTokenCost: number;
}

export type RerankStatus = "skipped" | "applied" | "fallback";
export type ActivityStageStatus = "applied" | "skipped" | "fallback" | "rejected" | "unavailable" | "failed";
export type RetrievalExecutionSurface = "assistant" | "retrieval" | "mcp_capability";
export type RetrievalExecutionPath =
  | "assistant_direct"
  | "assistant_retrieval"
  | "retrieval_search"
  | "retrieval_answer"
  | "mcp_grounded_answer";

export interface RetrievalExecutionMetadata {
  surface: RetrievalExecutionSurface;
  path: RetrievalExecutionPath;
  retrievalInvoked: boolean;
}

export interface RetrievalAnswerShapeSelection {
  shapeName: RetrievalAnswerShapeName;
  queryShape: RetrievalQueryShape;
  selectionMode: "deterministic" | "probabilistic";
  selectionReason: string;
  selectionConfidence?: number;
  resolvedRun: ResolvedSkillRun;
}

export interface ActivitySummary {
  traceId?: string;
  skillName?: string;
  surface?: string;
  path?: string;
  status?: "success" | "skipped" | "blocked" | "failed" | "fallback" | "pending";
  outcome?: string;
  primaryCounts?: Record<string, number>;
  assistant?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  execution?: RetrievalExecutionMetadata;
  parsedQuery?: {
    originalQuery: string;
    semanticQuery: string;
    lexicalQuery: string;
    constraintSummary: string[];
  };
  retrievalSubqueries?: Array<{
    id: string;
    label: string;
    semanticQuery: string;
    lexicalQuery: string;
    reason?: string;
    responseLanguagePolicy?: ResponseLanguagePolicy;
  }>;
  responseIntent?: ResponseIntent;
  retrievalSkipped?: boolean;
  intentConfidence?: number;
  intentFallbackApplied?: boolean;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  candidateCounts?: {
    semantic: number;
    lexical: number;
    merged: number;
    final: number;
  };
  appliedConstraints?: AppliedConstraint[];
  fallbackApplied?: boolean;
  rerankStatus?: RerankStatus;
  rewrite?: {
    status: RewriteStatus;
    eligible: boolean;
    ran: boolean;
    materialDisagreement: boolean;
    continuityDecision?: ContinuityDecision;
    rejectionReason?: string;
    fallbackReason?: string;
  };
  triggerAnalysis?: TriggerAnalysisResult;
  triggerBackoff?: TriggerBackoffDecision;
  shapeName?: RetrievalAnswerShapeName;
  queryShape?: RetrievalQueryShape;
  resolvedSteps?: Array<Record<string, unknown>>;
  skillDiagnostic?: SkillDiagnostic;
}

export interface ActivityStage {
  stageId: string;
  kind: string;
  label: string;
  status: ActivityStageStatus;
  startedAt?: string;
  durationMs?: number;
  settings?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  metrics?: Record<string, number>;
  reason?: string;
}

export interface ActivityLink {
  fromStageId: string;
  toStageId: string;
  kind: "sequence" | "branch" | "converge";
}

export interface ActivityTrace {
  traceId: string;
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  stages: ActivityStage[];
  links: ActivityLink[];
  summary?: ActivitySummary;
}

export interface RetrievalExecutionDiagnostics {
  execution?: RetrievalExecutionMetadata;
  rewriteStatus: RewriteStatus;
  rerankStatus: RerankStatus;
  originalCandidateCount: number;
  rewrittenCandidateCount: number;
  lexicalCandidateCount?: number;
  normalizedCandidateCount: number;
  finalContextCount: number;
  queryEmbeddingDurationMs?: number;
  responseIntent?: ResponseIntent;
  retrievalSkipped?: boolean;
  intentConfidence?: number;
  intentFallbackApplied?: boolean;
  parsedQuery?: ParsedQueryInterpretation;
  appliedConstraints?: AppliedConstraint[];
  candidateFallbackApplied: boolean;
  fallbackApplied: boolean;
  rewriteEligible?: boolean;
  rewriteRan?: boolean;
  materialDisagreement?: boolean;
  continuityDecision?: ContinuityDecision;
  rewriteProposal?: StructuredRewriteResult;
  retrievalSubqueries?: RetrievalSubquery[];
  responseLanguagePolicy?: ResponseLanguagePolicy;
  rejectionReason?: string;
  fallbackReason?: string;
  triggerAnalysis?: TriggerAnalysisResult;
  triggerBackoff?: TriggerBackoffDecision;
  shapeSelection?: RetrievalAnswerShapeSelection;
  skillDiagnostic?: SkillDiagnostic;
}
