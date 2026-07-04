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

export interface VectorIndexPort {
  upsertChunks?(input: {
    workspaceId: string;
    documentId: string;
    chunks: VectorIndexChunk[];
  }): Promise<void>;

  deleteDocumentChunks?(input: {
    workspaceId: string;
    documentId: string;
  }): Promise<void>;

  search(input: VectorIndexSearchInput): Promise<VectorIndexCandidate[]>;

  health?(): Promise<VectorIndexHealth>;
}
