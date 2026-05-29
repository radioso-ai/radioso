import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";

export type TextChunkingMethod = "fixed_window" | "recursive" | "semantic";

export interface TextChunkingEmbeddingPort {
  embedTexts(texts: string[], options?: { model?: string; usageContext?: ModelCallUsageContext }): Promise<number[][]>;
}

export interface TextChunkingProviderRequest {
  method: TextChunkingMethod;
  title?: string;
  content: string;
  chunkSize: number;
  chunkOverlap?: number;
  minCharactersPerChunk?: number;
  embeddingModel?: string;
  embeddingUsageContext?: ModelCallUsageContext;
}

export interface TextChunkingProviderChunk {
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface TextChunkingProviderPort {
  name: string;
  chunkText(request: TextChunkingProviderRequest): Promise<TextChunkingProviderChunk[]>;
}
