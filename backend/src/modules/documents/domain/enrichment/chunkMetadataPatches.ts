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

const rangesOverlap = (
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean => left.start < right.end && right.start < left.end;

/**
 * One patch per chunk a dated fact overlaps. A chunk holding several dated
 * facts — a short weekly list in one chunk — carries their span, from the
 * earliest start to the latest end, so none of its dates falls outside it.
 */
export const buildChunkMetadataPatches = (
  chunks: EnrichableChunk[],
  facts: Array<Partial<TemporalFact> & Pick<TemporalFact, "sourceRange">>,
): ChunkMetadataPatch[] => {
  const patches: ChunkMetadataPatch[] = [];

  for (const chunk of chunks) {
    const starts: string[] = [];
    const ends: string[] = [];
    for (const fact of facts) {
      // A fact with no range was quoted from the title and sits on no chunk.
      if (!fact.dateFrom || !fact.sourceRange || !rangesOverlap(fact.sourceRange, { start: chunk.startOffset, end: chunk.endOffset })) {
        continue;
      }
      starts.push(fact.dateFrom);
      ends.push(fact.dateTo ?? fact.dateFrom);
    }
    // ISO calendar dates order lexically.
    const dateFrom = starts.sort()[0];
    const dateTo = ends.sort().at(-1);
    if (dateFrom && dateTo) {
      patches.push({ chunkIndex: chunk.chunkIndex, metadata: { dateFrom, dateTo } });
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
