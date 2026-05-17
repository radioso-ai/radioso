import {
  type ChunkOutput,
  type ChunkingRequest,
  type ChunkingStrategy,
  normalizeMarkdown,
} from "./chunkingStrategy.js";
import type { TextChunkingProviderPort } from "./chunkingProvider.js";
import { normalizeProviderChunks } from "./providerChunkAdapter.js";

export class StructuredSemanticChunkingStrategy implements ChunkingStrategy {
  readonly id = "structured_semantic" as const;

  constructor(private readonly provider: TextChunkingProviderPort) {}

  async chunk(request: ChunkingRequest): Promise<ChunkOutput[]> {
    const normalized = normalizeMarkdown(request.content);

    if (normalized.length === 0) {
      return [];
    }

    const chunks = await this.chunkWithSemanticFallback({
      title: request.title,
      content: normalized,
      chunkSize: request.config.structuredMaxChunkSize,
      minCharactersPerChunk: request.config.structuredMinChunkSize,
    });

    return normalizeProviderChunks(normalized, chunks);
  }

  private async chunkWithSemanticFallback(request: {
    title?: string;
    content: string;
    chunkSize: number;
    minCharactersPerChunk: number;
  }) {
    try {
      return await this.provider.chunkText({
        method: "semantic",
        ...request,
      });
    } catch {
      return this.provider.chunkText({
        method: "recursive",
        ...request,
      });
    }
  }
}
