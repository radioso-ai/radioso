import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "./structuredAttributes.js";

export interface ConversationContextWindow {
  selectedMessages: MessageRecord[];
  truncated: boolean;
  selectionReason: string;
}

export type RewriteStatus = "skipped" | "applied" | "fallback";

export interface RewrittenRetrievalQuery {
  originalQuery: string;
  rewrittenQuery: string;
  effectiveQuery: string;
  rewriteApplied: boolean;
  status: RewriteStatus;
  confidence: number;
  fallbackReason?: string;
}

export type RetrievalSource = "semantic_original" | "semantic_rewritten" | "lexical";

export interface RetrievedCandidate extends RetrievedChunk {
  retrievalSources: RetrievalSource[];
  retrievalText: string;
  semanticScore: number;
  lexicalScore: number;
  attributeMatchScore?: number;
  subjectLabel?: string | null;
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
  entityAmbiguityDetected?: boolean;
  selectedSubjects?: string[];
}
