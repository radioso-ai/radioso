import type {
  ModelCallUsageContext,
} from "../../../shared/domain/modelCallUsageContext.js";

export interface EmbeddingSpaceRef {
  readonly id: string;
  readonly dimensions: number;
  readonly distanceMetric: "cosine";
}

export interface EmbeddingUsageItem {
  readonly chunkIndex: number;
  readonly chunkId?: string | null;
  readonly contentBytes: number;
  readonly estimatedTokens?: number | null;
}

export interface EmbeddingUsageSummary {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly providerRequestId?: string;
  readonly quality: "actual" | "estimated";
}

export interface QueryEmbeddingRequest {
  readonly workspaceId: string;
  readonly texts: readonly string[];
  readonly usageContext?: ModelCallUsageContext;
}

export interface QueryEmbeddingPort {
  embedQueries(request: QueryEmbeddingRequest): Promise<EmbeddingConsumerResult>;
}

export interface DocumentEmbeddingRequest {
  readonly workspaceId: string;
  readonly texts: readonly string[];
  readonly usageContext?: ModelCallUsageContext;
  readonly sourceId?: string | null;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly jobId?: string | null;
  readonly usageItems?: readonly EmbeddingUsageItem[];
}

export interface EmbeddingConsumerResult {
  readonly space: EmbeddingSpaceRef;
  readonly vectors: readonly number[][];
  readonly usage?: EmbeddingUsageSummary;
}

export interface DocumentEmbeddingPort {
  embedDocumentChunks(
    request: DocumentEmbeddingRequest,
  ): Promise<EmbeddingConsumerResult>;
}

export interface PinnedDocumentEmbeddingRequest
extends DocumentEmbeddingRequest {
  /**
   * Opaque durable target selected by application composition. Consumers never
   * receive the model, provider, dimensions, normalization, or provider task.
   */
  readonly embeddingSpaceId: string;
  readonly jobId: string;
  readonly usageItems: readonly EmbeddingUsageItem[];
  readonly usageContext: ModelCallUsageContext;
}

export interface PinnedDocumentEmbeddingPort {
  embedDocumentChunksForSpace(
    request: PinnedDocumentEmbeddingRequest,
  ): Promise<EmbeddingConsumerResult>;
}

export interface ClusteringEmbeddingRequest {
  readonly workspaceId: string;
  readonly texts: readonly string[];
  readonly usageContext?: ModelCallUsageContext;
}

export interface ClusteringEmbeddingPort {
  embedForClustering(
    request: ClusteringEmbeddingRequest,
  ): Promise<ClusteringEmbeddingResult>;
}

export interface ClusteringEmbeddingResult {
  readonly vectors: readonly number[][];
  readonly usage?: EmbeddingUsageSummary;
}
