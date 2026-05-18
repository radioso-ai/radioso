import {
  type ChunkOutput,
  type ChunkingRequest,
  type ChunkingStrategy,
  normalizeMarkdown,
} from "./chunkingStrategy.js";
import type { TextChunkingProviderPort } from "./chunkingProvider.js";
import { normalizeProviderChunks } from "./providerChunkAdapter.js";

export class RecursiveTextChunkingStrategy implements ChunkingStrategy {
  readonly id = "recursive_text" as const;

  constructor(private readonly provider: TextChunkingProviderPort) {}

  async chunk(request: ChunkingRequest): Promise<ChunkOutput[]> {
    const normalized = normalizeMarkdown(request.content);

    if (normalized.length === 0) {
      return [];
    }

    const chunks = await this.provider.chunkText({
      method: "recursive",
      title: request.title,
      content: normalized,
      chunkSize: request.config.fixedWindowChunkSize,
      minCharactersPerChunk: request.config.structuredMinChunkSize,
    });

    return normalizeProviderChunks(normalized, chunks);
  }
}
