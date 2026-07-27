import type { VectorChunkFilter } from "./vectorFilter.js";

export interface VectorIndexCandidate {
  chunkId: string;
  documentId?: string;
  score: number;
}

export type VectorIndexFilter = VectorChunkFilter;

export interface VectorIndexSearchInput {
  workspaceId: string;
  queryEmbedding: number[];
  queryEmbeddingDimensions: number;
  topK: number;
  similarityThreshold: number;
  embeddingModel: string;
  filter: VectorIndexFilter;
}

export interface VectorIndexChunk {
  id: string;
  documentId: string;
  workspaceId: string;
  chunkIndex: number;
  embedding: number[];
  embeddingModel: string;
  metadata: Record<string, unknown>;
}

export interface VectorIndexHealth {
  ok: boolean;
}

/**
 * Compatibility search port for the current pgvector-backed retrieval callers.
 *
 * New vector lifecycle work uses the mandatory narrow ports in
 * `vectorAdapter.ts`. This legacy shape remains until active embedding-space
 * routing replaces model-string routing in production.
 */
export interface VectorIndexPort {
  search(input: VectorIndexSearchInput): Promise<VectorIndexCandidate[]>;
}
