import {
  type ChunkOutput,
  type ChunkingRequest,
  type ChunkingStrategy,
  normalizeMarkdown,
} from "./chunkingStrategy.js";

const TARGET_CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

export const chunkFixedWindowMarkdown = (content: string): ChunkOutput[] => {
  const normalized = normalizeMarkdown(content);

  if (normalized.length === 0) {
    return [];
  }

  if (normalized.length <= TARGET_CHUNK_SIZE) {
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
    const next = Math.min(cursor + TARGET_CHUNK_SIZE, normalized.length);
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

    cursor = Math.max(0, next - CHUNK_OVERLAP);
  }

  return chunks;
};

export class FixedWindowChunkingStrategy implements ChunkingStrategy {
  readonly id = "fixed_window" as const;

  async chunk(request: ChunkingRequest): Promise<ChunkOutput[]> {
    return chunkFixedWindowMarkdown(request.content);
  }
}
