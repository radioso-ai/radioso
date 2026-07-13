import type { TemporalFact } from "./documentEnrichmentContract.js";

export interface EnrichableChunk {
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, unknown>;
}

export interface ChunkMetadataPatch {
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

export const rangesOverlap = (
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean => left.start < right.end && right.start < left.end;

export const buildChunkMetadataPatches = (
  chunks: EnrichableChunk[],
  facts: Array<Partial<TemporalFact> & Pick<TemporalFact, "sourceRange">>,
): ChunkMetadataPatch[] => {
  const patches: ChunkMetadataPatch[] = [];

  for (const chunk of chunks) {
    for (const fact of facts) {
      if (!fact.dateFrom || !rangesOverlap(fact.sourceRange, { start: chunk.startOffset, end: chunk.endOffset })) {
        continue;
      }
      patches.push({
        chunkIndex: chunk.chunkIndex,
        metadata: {
          dateFrom: fact.dateFrom,
          dateTo: fact.dateTo ?? fact.dateFrom,
        },
      });
    }
  }

  return patches;
};

export const applyMetadataPatches = <TChunk extends EnrichableChunk>(
  chunks: TChunk[],
  patches: ChunkMetadataPatch[],
): TChunk[] => {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const patch of patches) {
    byIndex.set(patch.chunkIndex, {
      ...(byIndex.get(patch.chunkIndex) ?? {}),
      ...patch.metadata,
    });
  }

  return chunks.map((chunk) => ({
    ...chunk,
    metadata: {
      ...(chunk.metadata ?? {}),
      ...(byIndex.get(chunk.chunkIndex) ?? {}),
    },
  }));
};
