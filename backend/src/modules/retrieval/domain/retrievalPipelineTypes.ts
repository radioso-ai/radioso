import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "./structuredAttributes.js";

export interface ConversationContextWindow {
  selectedMessages: MessageRecord[];
  truncated: boolean;
  selectionReason: string;
}

export type RewriteStatus = "skipped" | "applied" | "fallback" | "rejected";

export type RewriteTurnKind =
  | "fresh_subject"
  | "referential_followup"
  | "referential_relation"
  | "explicit_recenter"
  | "comparative"
  | "ambiguous";

export interface StructuredRewriteResult {
  rewrittenQuery: string;
  turnKind: RewriteTurnKind;
  proposedActiveSubject?: string;
  relatedEntities: string[];
  unresolved: boolean;
  confidence: number;
}

export type ContinuityDecision = "unchanged" | "reused" | "updated" | "unresolved" | "rejected";

export interface RewrittenRetrievalQuery {
  originalQuery: string;
  rewrittenQuery: string;
  effectiveQuery: string;
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

export interface RetrievalExecutionDiagnostics {
  rewriteStatus: RewriteStatus;
  rerankStatus: RerankStatus;
  originalCandidateCount: number;
  rewrittenCandidateCount: number;
  lexicalCandidateCount?: number;
  normalizedCandidateCount: number;
  finalContextCount: number;
  parsedQuery?: ParsedQueryInterpretation;
  appliedConstraints?: AppliedConstraint[];
  candidateFallbackApplied: boolean;
  fallbackApplied: boolean;
  rewriteEligible?: boolean;
  rewriteRan?: boolean;
  materialDisagreement?: boolean;
  continuityDecision?: ContinuityDecision;
  rewriteProposal?: StructuredRewriteResult;
  rejectionReason?: string;
}
