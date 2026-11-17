import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";

/** Fixed-window chunking needs no provider: it splits at text boundaries itself (`textBoundaryWindows.ts`). */
export type TextChunkingMethod = "recursive" | "semantic";

export interface TextChunkingProviderRequest {
  method: TextChunkingMethod;
  title?: string;
  content: string;
  chunkSize: number;
  minCharactersPerChunk?: number;
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
