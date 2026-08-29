import type { RetrievalSourceFilter } from "./retrievalSourceFilter.js";
import type { VectorMetadataFilter } from "./vectorFilter.js";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  searchText?: string | null;
  similarity: number;
  lexicalRankScore?: number;
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
