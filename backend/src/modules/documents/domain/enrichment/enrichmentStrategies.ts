import {
  applyMetadataPatches,
  buildChunkMetadataPatches,
  type ChunkMetadataPatch,
  type EnrichableChunk,
} from "./chunkMetadataPatches.js";
import type { DocumentShape, TemporalFact } from "./documentEnrichmentContract.js";

export interface DocumentEnrichmentStrategyInput<TChunk extends EnrichableChunk = EnrichableChunk> {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  facts: TemporalFact[];
  /**
   * Facts the run dropped before placing these: invalid, or quoting text the
   * document does not contain. Omitted means unknown, and is read as "some".
   */
  droppedFactCount?: number;
}

export interface DocumentEnrichmentStrategyResult<TChunk extends EnrichableChunk = EnrichableChunk> {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  appliedChunkCount: number;
}

export interface DocumentEnrichmentStrategy {
  readonly shape: DocumentShape;
  apply<TChunk extends EnrichableChunk>(input: DocumentEnrichmentStrategyInput<TChunk>): DocumentEnrichmentStrategyResult<TChunk>;
}

export interface DocumentEnrichmentStrategyRegistry {
  get(shape: DocumentShape): DocumentEnrichmentStrategy;
}

class StaticDocumentEnrichmentStrategyRegistry implements DocumentEnrichmentStrategyRegistry {
  private readonly strategies: Map<DocumentShape, DocumentEnrichmentStrategy>;

  constructor(strategies: DocumentEnrichmentStrategy[]) {
    this.strategies = new Map(strategies.map((strategy) => [strategy.shape, strategy]));
  }

  get(shape: DocumentShape): DocumentEnrichmentStrategy {
    return this.strategies.get(shape) ?? this.strategies.get("generic")!;
  }
}

type DateRange = { dateFrom: string; dateTo: string };

/** The one date range every given fact names, if they name exactly one. */
const sharedRange = (facts: TemporalFact[]): DateRange | null => {
  const ranges = new Map<string, DateRange>();
  for (const fact of facts) {
    if (fact.dateFrom) {
      const range = { dateFrom: fact.dateFrom, dateTo: fact.dateTo ?? fact.dateFrom };
      ranges.set(`${range.dateFrom}/${range.dateTo}`, range);
    }
  }
  return ranges.size === 1 ? [...ranges.values()][0] ?? null : null;
};

/**
 * A fact carries the span of the text that states its date, which is shorter
 * than the text about the event, so each fact dates the chunks it was quoted
 * from, and a document-wide range dates every other chunk. The range is
 * document-wide when every fact names it — the document is about one dated
 * event, wherever the date is stated — or else when every fact quoted from
 * the title names it.
 *
 * Only a complete reading spreads a range: no fact dropped, and every fact
 * resolved to a date. An uncovered chunk may otherwise hold exactly the date
 * the run lost, and stamping it with a survivor's date would be wrong.
 */
const eventChunkPatches = (
  chunks: EnrichableChunk[],
  facts: TemporalFact[],
  droppedFactCount: number | undefined,
): ChunkMetadataPatch[] => {
  const patches = buildChunkMetadataPatches(chunks, facts);
  const complete = droppedFactCount === 0 && facts.every((fact) => Boolean(fact.dateFrom));
  const documentWide = complete
    ? sharedRange(facts) ?? sharedRange(facts.filter((fact) => fact.sourceRange === null))
    : null;
  if (!documentWide) {
    return patches;
  }
  const dated = new Set(patches.map((patch) => patch.chunkIndex));
  return [
    ...patches,
    ...chunks
      .filter((chunk) => !dated.has(chunk.chunkIndex))
      .map((chunk) => ({ chunkIndex: chunk.chunkIndex, metadata: { ...documentWide } })),
  ];
};

const eventStrategy: DocumentEnrichmentStrategy = {
  shape: "event",
  apply(input) {
    const eventFacts = input.facts.filter((fact) => fact.kind === "event_date");
    const patches = eventChunkPatches(input.chunks, eventFacts, input.droppedFactCount);
    const patchedChunks = applyMetadataPatches(input.chunks, patches);
    // Extracted tags belong in the document's flat metadata too, so operators
    // can see and edit them like any hand-written tag. The document carries the
    // overall event span; chunk-level tags stay precise per fact.
    const resolvedStarts = eventFacts
      .map((fact) => fact.dateFrom)
      .filter((value): value is string => Boolean(value))
      .sort();
    const resolvedEnds = eventFacts
      .map((fact) => fact.dateTo ?? fact.dateFrom)
      .filter((value): value is string => Boolean(value))
      .sort();
    const documentMetadata =
      resolvedStarts.length > 0
        ? {
            ...input.documentMetadata,
            dateFrom: resolvedStarts[0],
            dateTo: resolvedEnds[resolvedEnds.length - 1],
          }
        : { ...input.documentMetadata };
    return {
      documentMetadata,
      chunks: patchedChunks,
      appliedChunkCount: new Set(patches.map((patch) => patch.chunkIndex)).size,
    };
  },
};

const articleStrategy: DocumentEnrichmentStrategy = {
  shape: "article",
  apply(input) {
    const resolvedFact = input.facts.find((fact) => fact.kind === "article_date" && fact.dateFrom);
    if (!resolvedFact?.dateFrom) {
      return {
        documentMetadata: { ...input.documentMetadata },
        chunks: input.chunks,
        appliedChunkCount: 0,
      };
    }

    const documentMetadata = {
      ...input.documentMetadata,
      dateFrom: resolvedFact.dateFrom,
      dateTo: resolvedFact.dateTo ?? resolvedFact.dateFrom,
    };

    return {
      documentMetadata,
      chunks: input.chunks.map((chunk) => ({
        ...chunk,
        metadata: {
          ...(chunk.metadata ?? {}),
          dateFrom: documentMetadata.dateFrom,
          dateTo: documentMetadata.dateTo,
        },
      })),
      appliedChunkCount: input.chunks.length,
    };
  },
};

const noTemporalFactStrategy = (shape: DocumentShape): DocumentEnrichmentStrategy => ({
  shape,
  apply(input) {
    return {
      documentMetadata: { ...input.documentMetadata },
      chunks: input.chunks,
      appliedChunkCount: 0,
    };
  },
});

export const createDefaultDocumentEnrichmentStrategyRegistry = (): DocumentEnrichmentStrategyRegistry =>
  new StaticDocumentEnrichmentStrategyRegistry([
    eventStrategy,
    articleStrategy,
    noTemporalFactStrategy("profile"),
    noTemporalFactStrategy("reference"),
    noTemporalFactStrategy("generic"),
  ]);
