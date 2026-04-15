import {
  type ChunkOutput,
  type ChunkingRequest,
  type ChunkingStrategy,
  normalizeMarkdown,
} from "./chunkingStrategy.js";
import { RETRIEVAL_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";

export const chunkFixedWindowMarkdown = (
  content: string,
  options: { chunkSize?: number; chunkOverlap?: number } = {},
): ChunkOutput[] => {
  const chunkSize = options.chunkSize ?? RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeDefault;
  const chunkOverlap = options.chunkOverlap ?? RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapDefault;
  const normalized = normalizeMarkdown(content);

  if (normalized.length === 0) {
    return [];
  }

  if (normalized.length <= chunkSize) {
    return [
      {
        chunkIndex: 0,
        content: normalized,
        startOffset: 0,
        endOffset: normalized.length,
      },
    ];
  }

  const chunks: ChunkOutput[] = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < normalized.length) {
    const next = Math.min(cursor + chunkSize, normalized.length);
    const slice = normalized.slice(cursor, next).trim();

    if (slice.length > 0) {
      chunks.push({
        chunkIndex,
        content: slice,
        startOffset: cursor,
        endOffset: next,
      });
      chunkIndex += 1;
    }

    if (next === normalized.length) {
      break;
    }

    cursor = Math.max(0, next - chunkOverlap);
  }

  return chunks;
};

export class FixedWindowChunkingStrategy implements ChunkingStrategy {
  readonly id = "fixed_window" as const;

  async chunk(request: ChunkingRequest): Promise<ChunkOutput[]> {
    return chunkFixedWindowMarkdown(request.content, {
      chunkSize: request.config.fixedWindowChunkSize,
      chunkOverlap: request.config.fixedWindowChunkOverlap,
    });
  }
}
