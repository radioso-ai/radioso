export interface ChunkOutput {
  chunkIndex: number;
  content: string;
  startOffset: number;
  endOffset: number;
}

const TARGET_CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

export const normalizeMarkdown = (content: string): string => content.trim();

export const chunkMarkdown = (content: string): ChunkOutput[] => {
  const normalized = normalizeMarkdown(content);

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
