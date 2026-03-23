import {
  type ChunkOutput,
  type ChunkingRequest,
  type ChunkingStrategy,
  normalizeMarkdown,
} from "./chunkingStrategy.js";
import { planStructuredChunks } from "./blockMergePlanner.js";
import { parseStructuralBlocks, type StructuralBlock } from "./structuredBlockParser.js";

export interface ChunkingSimilarityPort {
  embedTexts(texts: string[]): Promise<number[][]>;
}

const MAX_FRAGMENT_CHARS = 900;

export class StructuredSemanticChunkingStrategy implements ChunkingStrategy {
  readonly id = "structured_semantic" as const;

  constructor(private readonly similarityPort: ChunkingSimilarityPort) {}

  async chunk(request: ChunkingRequest): Promise<ChunkOutput[]> {
    const normalized = normalizeMarkdown(request.content);

    if (normalized.length === 0) {
      return [];
    }

    const blocks = splitOversizedBlocks(normalized, parseStructuralBlocks(normalized));
    const adjacentSimilarities = await this.getAdjacentSimilarities(blocks);

    return planStructuredChunks({
      content: normalized,
      blocks,
      adjacentSimilarities,
      minChunkTokens: request.config.structuredMinChunkSize,
      maxChunkTokens: request.config.structuredMaxChunkSize,
    });
  }

  private async getAdjacentSimilarities(blocks: StructuralBlock[]): Promise<number[] | undefined> {
    try {
      const embeddings = await this.similarityPort.embedTexts(blocks.map((block) => block.content));
      return embeddings.slice(0, -1).map((embedding, index) => cosineSimilarity(embedding, embeddings[index + 1] ?? []));
    } catch {
      return undefined;
    }
  }
}

const splitOversizedBlocks = (content: string, blocks: StructuralBlock[]): StructuralBlock[] => {
  const expanded: StructuralBlock[] = [];

  for (const block of blocks) {
    if (block.content.length <= MAX_FRAGMENT_CHARS) {
      expanded.push(block);
      continue;
    }

    let startOffset = block.startOffset;
    while (startOffset < block.endOffset) {
      const endOffset = Math.min(startOffset + MAX_FRAGMENT_CHARS, block.endOffset);
      const fragment = buildFragment(content, block, startOffset, endOffset);

      if (fragment) {
        expanded.push(fragment);
      }

      startOffset = endOffset;
    }
  }

  return expanded;
};

const buildFragment = (
  content: string,
  block: StructuralBlock,
  rawStartOffset: number,
  rawEndOffset: number,
): StructuralBlock | null => {
  let startOffset = rawStartOffset;
  let endOffset = rawEndOffset;

  while (startOffset < endOffset && /\s/.test(content[startOffset] ?? "")) {
    startOffset += 1;
  }
  while (endOffset > startOffset && /\s/.test(content[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }

  if (startOffset >= endOffset) {
    return null;
  }

  const fragmentContent = content.slice(startOffset, endOffset);

  return {
    kind: block.kind,
    content: fragmentContent,
    startOffset,
    endOffset,
    tokenCount: fragmentContent.match(/\S+/g)?.length ?? 0,
  };
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
    leftMagnitude += (left[index] ?? 0) ** 2;
    rightMagnitude += (right[index] ?? 0) ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};
