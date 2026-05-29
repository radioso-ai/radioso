import type { EmbeddingClient, ProviderUsage } from "../../../shared/infra/llm/providerTypes.js";
import { renderSearchText } from "./searchTextRenderer.js";

export interface EmbeddingRequestOptions {
  model?: string;
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
  constructor(private readonly client: EmbeddingClient) {}

  async embedTexts(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    const { vectors } = await this.embedTextsWithUsage(texts, options);
    return vectors;
  }

  async embedTextsWithUsage(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    return this.client.embedTexts(texts, options);
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
