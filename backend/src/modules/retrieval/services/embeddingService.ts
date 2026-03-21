import type { EmbeddingClient } from "../../../shared/infra/llm/providerTypes.js";
import { renderSearchText } from "./searchTextRenderer.js";

export interface EmbeddingGateway {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export const buildRetrievalText = (input: { title: string; content: string }): string =>
  renderSearchText({
    title: input.title,
    content: input.content,
  });

export class ModelEmbeddingGateway implements EmbeddingGateway {
  constructor(private readonly client: EmbeddingClient) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    return this.client.embedTexts(texts);
  }
}

export class OpenAIEmbeddingGateway extends ModelEmbeddingGateway {}

export class EmbeddingService {
  constructor(private readonly gateway: EmbeddingGateway) {}

  async embedChunks(chunks: string[]): Promise<number[][]> {
    return this.gateway.embedTexts(chunks);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return this.gateway.embedTexts(texts);
  }
}
