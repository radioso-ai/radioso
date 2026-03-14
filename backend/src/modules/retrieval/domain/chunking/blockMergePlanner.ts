import type { ChunkOutput } from "./chunkingStrategy.js";
import type { StructuralBlock } from "./structuredBlockParser.js";

export interface BlockMergePlanInput {
  content: string;
  blocks: StructuralBlock[];
  adjacentSimilarities?: number[];
  minChunkTokens?: number;
  maxChunkTokens?: number;
  similarityThreshold?: number;
}

const DEFAULT_MIN_CHUNK_TOKENS = 24;
const DEFAULT_MAX_CHUNK_TOKENS = 220;
const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

export const planStructuredChunks = ({
  content,
  blocks,
  adjacentSimilarities,
  minChunkTokens = DEFAULT_MIN_CHUNK_TOKENS,
  maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
}: BlockMergePlanInput): ChunkOutput[] => {
  if (blocks.length === 0) {
    return [];
  }

  const chunks: ChunkOutput[] = [];
  let chunkIndex = 0;
  let current = {
    startOffset: blocks[0].startOffset,
    endOffset: blocks[0].endOffset,
    tokenCount: blocks[0].tokenCount,
    blockCount: 1,
  };

  for (let index = 1; index < blocks.length; index += 1) {
    const next = blocks[index];
    const wouldExceedMax = current.tokenCount + next.tokenCount > maxChunkTokens;
    const startsNewSection = next.kind === "heading";
    const similarity = adjacentSimilarities?.[index - 1];
    const shouldMergeForMinimum = current.tokenCount < minChunkTokens && !startsNewSection && !wouldExceedMax;
    const shouldMergeForSimilarity =
      typeof similarity === "number" && similarity >= similarityThreshold && !startsNewSection && !wouldExceedMax;

    if (!wouldExceedMax && (shouldMergeForMinimum || shouldMergeForSimilarity)) {
      current.endOffset = next.endOffset;
      current.tokenCount += next.tokenCount;
      current.blockCount += 1;
      continue;
    }

    chunks.push(buildChunk(content, chunkIndex, current.startOffset, current.endOffset));
    chunkIndex += 1;
    current = {
      startOffset: next.startOffset,
      endOffset: next.endOffset,
      tokenCount: next.tokenCount,
      blockCount: 1,
    };
  }

  chunks.push(buildChunk(content, chunkIndex, current.startOffset, current.endOffset));

  return chunks;
};

const buildChunk = (content: string, chunkIndex: number, rawStartOffset: number, rawEndOffset: number): ChunkOutput => {
  let startOffset = rawStartOffset;
  let endOffset = rawEndOffset;

  while (startOffset < endOffset && /\s/.test(content[startOffset] ?? "")) {
    startOffset += 1;
  }
  while (endOffset > startOffset && /\s/.test(content[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }

  return {
    chunkIndex,
    content: content.slice(startOffset, endOffset),
    startOffset,
    endOffset,
  };
};
