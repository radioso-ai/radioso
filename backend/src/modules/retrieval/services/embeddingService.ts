import type OpenAI from "openai";
import { renderSearchText } from "./searchTextRenderer.js";

export interface EmbeddingGateway {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export const buildRetrievalText = (input: { title: string; content: string }): string =>
  renderSearchText({
    title: input.title,
    content: input.content,
  });

export class OpenAIEmbeddingGateway implements EmbeddingGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }
}

export class EmbeddingService {
  constructor(private readonly gateway: EmbeddingGateway) {}

  async embedChunks(chunks: string[]): Promise<number[][]> {
    return this.gateway.embedTexts(chunks);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return this.gateway.embedTexts(texts);
  }
}
