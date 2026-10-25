import type { RetrievalSourceFilter } from "./retrievalSourceFilter.js";
import type { VectorMetadataFilter } from "./vectorFilter.js";

/**
 * How much of a lexical query a matched chunk holds. Lexical search first asks for every
 * term (`all_terms`); when too few chunks hold them all, it also returns chunks holding
 * part of the query (`some_terms`). A consumer that reads a lexical hit as "the chunk
 * holds what was asked for" counts only `all_terms` hits. A lexical hit without a
 * coverage value holds every term.
 */
export type LexicalTermCoverage = "all_terms" | "some_terms";

export const isSomeTermsLexicalMatch = (hit: { lexicalTermCoverage?: LexicalTermCoverage }): boolean =>
  hit.lexicalTermCoverage === "some_terms";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  searchText?: string | null;
  similarity: number;
  lexicalRankScore?: number;
  /** Set on lexical hits; see {@link LexicalTermCoverage}. */
  lexicalTermCoverage?: LexicalTermCoverage;
  chunkIndex?: number;
  startOffset?: number | null;
  endOffset?: number | null;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchInput {
  workspaceId: string;
  queryEmbedding: number[];
  topK: number;
  similarityThreshold: number;
  embeddingModel?: string;
  metadataFilter?: VectorMetadataFilter;
  sourceFilter?: RetrievalSourceFilter;
}

/**
 * Compatibility surface for older callers that expect hydrated vector search
 * rows. New retrieval paths should use VectorCandidateSearchPort plus
 * ChunkCandidateHydratorPort so vector indexes return ranked references and
 * Postgres remains the canonical chunk hydration gate.
 */
export interface VectorSearchPort {
  search(input: VectorSearchInput): Promise<RetrievedChunk[]>;
}
