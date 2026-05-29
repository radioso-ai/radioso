import { randomUUID } from "node:crypto";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type {
  EmbeddingInferencePipeline,
  EmbeddingUsageItem,
} from "../../../shared/infra/llm/embeddingInferencePipeline.js";
import type { ProviderUsage } from "../../../shared/infra/llm/providerTypes.js";
import { renderSearchText } from "./searchTextRenderer.js";

export interface EmbeddingRequestOptions {
  model?: string;
  usageContext?: ModelCallUsageContext;
  sourceId?: string | null;
  documentId?: string | null;
  documentRevision?: number | null;
  jobId?: string | null;
  usageItems?: EmbeddingUsageItem[];
}

export interface EmbeddingBatchResult {
  vectors: number[][];
  usage?: ProviderUsage;
}

export interface EmbeddingGateway {
  embedTexts(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
  embedTextsWithUsage?(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult>;
}

export const buildRetrievalText = (input: { title: string; content: string }): string =>
  renderSearchText({
    title: input.title,
    content: input.content,
  });

export class ModelEmbeddingGateway implements EmbeddingGateway {
  constructor(private readonly pipeline: EmbeddingInferencePipeline) {}

  async embedTexts(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    const { vectors } = await this.embedTextsWithUsage(texts, options);
    return vectors;
  }

  async embedTextsWithUsage(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    if (!options?.usageContext) {
      const result = await this.pipeline.embedTexts({
        texts,
        model: options?.model,
        operation: {
          workspaceId: "unknown",
          requestId: randomUUID(),
          surface: "embedding",
          operation: "embedding",
          attemptKey: "unattributed",
        },
      });
      return result;
    }
    return this.pipeline.embedTexts({
      texts,
      model: options.model,
      operation: options.usageContext,
      sourceId: options.sourceId,
      documentId: options.documentId,
      documentRevision: options.documentRevision,
      jobId: options.jobId,
      items: options.usageItems,
    });
  }
}

export class OpenAIEmbeddingGateway extends ModelEmbeddingGateway {}

export class EmbeddingService {
  constructor(private readonly gateway: EmbeddingGateway) {}

  async embedChunks(chunks: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.gateway.embedTexts(chunks, options);
  }

  async embedChunksWithUsage(chunks: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    if (this.gateway.embedTextsWithUsage) {
      return this.gateway.embedTextsWithUsage(chunks, options);
    }
    return { vectors: await this.gateway.embedTexts(chunks, options) };
  }

  async embedTexts(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.gateway.embedTexts(texts, options);
  }
}
