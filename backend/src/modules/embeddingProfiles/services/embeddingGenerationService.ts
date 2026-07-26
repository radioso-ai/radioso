import { randomUUID } from "node:crypto";

import type {
  EmbeddingGenerationBatchResult,
  EmbeddingGenerationGateway,
  EmbeddingGenerationOptions,
  EmbeddingInferencePort,
} from "../contracts/embeddingGeneration.js";

export class ModelEmbeddingGenerationGateway
implements EmbeddingGenerationGateway {
  constructor(private readonly pipeline: EmbeddingInferencePort) {}

  async embedTexts(
    texts: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<number[][]> {
    const { vectors } = await this.embedTextsWithUsage(texts, options);
    return vectors;
  }

  async embedTextsWithUsage(
    texts: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<EmbeddingGenerationBatchResult> {
    return this.pipeline.embedTexts({
      texts: [...texts],
      model: options?.model,
      dimensions: options?.dimensions,
      purpose: options?.purpose,
      provider: options?.provider,
      endpointScopeFingerprint: options?.endpointScopeFingerprint,
      operation: options?.usageContext ?? {
        workspaceId: "unknown",
        requestId: randomUUID(),
        surface: "embedding",
        operation: "embedding",
        attemptKey: "unattributed",
      },
      sourceId: options?.sourceId,
      documentId: options?.documentId,
      documentRevision: options?.documentRevision,
      jobId: options?.jobId,
      items: options?.usageItems ? [...options.usageItems] : undefined,
    });
  }
}

export class OpenAIEmbeddingGenerationGateway
  extends ModelEmbeddingGenerationGateway {}

export class EmbeddingGenerationService {
  constructor(private readonly gateway: EmbeddingGenerationGateway) {}

  async embedChunks(
    chunks: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<number[][]> {
    return this.gateway.embedTexts(chunks, options);
  }

  async embedChunksWithUsage(
    chunks: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<EmbeddingGenerationBatchResult> {
    if (this.gateway.embedTextsWithUsage) {
      return this.gateway.embedTextsWithUsage(chunks, options);
    }
    return { vectors: await this.gateway.embedTexts(chunks, options) };
  }

  async embedTexts(
    texts: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<number[][]> {
    return this.gateway.embedTexts(texts, options);
  }
}
