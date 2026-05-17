import type { ChunkOutput } from "./chunkingStrategy.js";
import type { TextChunkingProviderChunk } from "./chunkingProvider.js";

export const normalizeProviderChunks = (content: string, chunks: TextChunkingProviderChunk[]): ChunkOutput[] => {
  const normalizedChunks: Array<Omit<ChunkOutput, "chunkIndex">> = [];
  let previousEndOffset = -1;

  const sortedChunks = [...chunks].sort((left, right) =>
    left.startOffset - right.startOffset || left.endOffset - right.endOffset
  );

  for (const chunk of sortedChunks) {
    const normalized = trimProviderChunk(content, chunk);

    if (!normalized) {
      continue;
    }

    if (normalized.endOffset <= previousEndOffset) {
      continue;
    }

    normalizedChunks.push(normalized);
    previousEndOffset = normalized.endOffset;
  }

  return normalizedChunks.map((chunk, chunkIndex) => ({
    chunkIndex,
    content: chunk.content,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
  }));
};

const trimProviderChunk = (
  content: string,
  chunk: TextChunkingProviderChunk,
): Omit<ChunkOutput, "chunkIndex"> | null => {
  const boundedStartOffset = clampInteger(chunk.startOffset, 0, content.length);
  const boundedEndOffset = clampInteger(chunk.endOffset, boundedStartOffset, content.length);
  let startOffset = boundedStartOffset;
  let endOffset = boundedEndOffset;

  while (startOffset < endOffset && /\s/.test(content[startOffset] ?? "")) {
    startOffset += 1;
  }
  while (endOffset > startOffset && /\s/.test(content[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }

  const chunkContent = chunk.content.trim();

  if (startOffset >= endOffset || chunkContent.length === 0) {
    return null;
  }

  const rawSlice = content.slice(boundedStartOffset, boundedEndOffset);
  const trimmedSlice = content.slice(startOffset, endOffset);
  const shouldTrustOriginalSlice = chunk.content === rawSlice || chunkContent === trimmedSlice;

  return {
    content: shouldTrustOriginalSlice ? trimmedSlice : chunkContent,
    startOffset,
    endOffset,
  };
};

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isInteger(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
};
