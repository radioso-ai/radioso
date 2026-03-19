import type OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { renderSearchText } from "./searchTextRenderer.js";
import type { UsageCaptureService } from "../../usage/services/usageCaptureService.js";
import { extractUsageMetrics } from "../../usage/services/usageCaptureService.js";

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
    private readonly usageCaptureService?: UsageCaptureService,
  ) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    const operationKey = randomUUID();

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });

      await this.usageCaptureService?.observe({
        operationKey,
        sourceArea: "retrieval",
        operationType: "embedding",
        model: this.model,
        eventStatus: "success",
        metadata: { inputCount: texts.length },
        ...extractUsageMetrics(response.usage),
      });

      return response.data.map((item) => item.embedding);
    } catch (error) {
      await this.usageCaptureService?.observe({
        operationKey,
        sourceArea: "retrieval",
        operationType: "embedding",
        model: this.model,
        eventStatus: "failure",
        usageAvailable: false,
        metadata: {
          inputCount: texts.length,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
      throw error;
    }
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
