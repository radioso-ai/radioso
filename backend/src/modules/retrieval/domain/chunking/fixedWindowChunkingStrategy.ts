import {
  type ChunkOutput,
  type ChunkingRequest,
  type ChunkingStrategy,
  normalizeMarkdown,
} from "./chunkingStrategy.js";
import { normalizeProviderChunks } from "./providerChunkAdapter.js";
import { splitIntoBoundedWindows } from "./textBoundaryWindows.js";

export class FixedWindowChunkingStrategy implements ChunkingStrategy {
  readonly id = "fixed_window" as const;

  async chunk(request: ChunkingRequest): Promise<ChunkOutput[]> {
    const normalized = normalizeMarkdown(request.content);

    if (normalized.length === 0) {
      return [];
    }

    const windows = splitIntoBoundedWindows(normalized, {
      maxChars: request.config.fixedWindowChunkSize,
      overlapChars: request.config.fixedWindowChunkOverlap,
    });

    return normalizeProviderChunks(
      normalized,
      windows.map((window) => ({ ...window, content: normalized.slice(window.startOffset, window.endOffset) })),
    );
  }
}
