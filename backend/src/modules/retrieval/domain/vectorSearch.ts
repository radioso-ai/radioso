import type { RetrievalSourceFilter } from "./retrievalSourceFilter.js";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  searchText?: string | null;
  similarity: number;
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
  metadataFilter?: Record<string, unknown>;
  sourceFilter?: RetrievalSourceFilter;
}

export interface VectorSearchPort {
  search(input: VectorSearchInput): Promise<RetrievedChunk[]>;
}
