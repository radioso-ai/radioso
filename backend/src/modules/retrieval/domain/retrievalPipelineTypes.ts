import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "./structuredAttributes.js";

export interface ConversationContextWindow {
  selectedMessages: MessageRecord[];
  truncated: boolean;
  selectionReason: string;
  rewriteCarryForwardLiterals?: string[];
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

export type ResponseLanguagePolicy = "match_user_question";

export interface StructuredRewriteResult {
  rewrittenQuery: string;
  semanticQuery?: string;
  lexicalQuery?: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
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
}

export type ContinuityDecision = "unchanged" | "reused" | "updated" | "unresolved" | "rejected";

export interface RewrittenRetrievalQuery {
  originalQuery: string;
  rewrittenQuery: string;
  effectiveQuery: string;
  semanticQuery: string;
  lexicalQuery: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  retrievalSubqueries?: RetrievalSubquery[];
  rewriteApplied: boolean;
  retrievalEligible: boolean;
  status: RewriteStatus;
  confidence: number;
  structuredResult?: StructuredRewriteResult;
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
export type RetrievalTraceStageStatus = "applied" | "skipped" | "fallback" | "rejected" | "unavailable" | "failed";

export interface RetrievalTraceSummary {
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
  responseLanguagePolicy?: ResponseLanguagePolicy;
  candidateCounts: {
    semantic: number;
    lexical: number;
    merged: number;
    final: number;
  };
  appliedConstraints?: AppliedConstraint[];
  fallbackApplied: boolean;
  rerankStatus: RerankStatus;
  rewrite?: {
    status: RewriteStatus;
    eligible: boolean;
    ran: boolean;
    materialDisagreement: boolean;
    continuityDecision?: ContinuityDecision;
    rejectionReason?: string;
    fallbackReason?: string;
  };
}

export interface RetrievalTraceStage {
  stageId: string;
  kind: string;
  label: string;
  status: RetrievalTraceStageStatus;
  startedAt?: string;
  durationMs?: number;
  settings?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  metrics?: Record<string, number>;
  reason?: string;
}

export interface RetrievalTraceLink {
  fromStageId: string;
  toStageId: string;
  kind: "sequence" | "branch" | "converge";
}

export interface RetrievalTrace {
  traceId: string;
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  stages: RetrievalTraceStage[];
  links: RetrievalTraceLink[];
  summary?: RetrievalTraceSummary;
}

export interface RetrievalExecutionDiagnostics {
  rewriteStatus: RewriteStatus;
  rerankStatus: RerankStatus;
  originalCandidateCount: number;
  rewrittenCandidateCount: number;
  lexicalCandidateCount?: number;
  normalizedCandidateCount: number;
  finalContextCount: number;
  queryEmbeddingDurationMs?: number;
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
}
