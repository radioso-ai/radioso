import {
  applyMetadataPatches,
  buildChunkMetadataPatches,
  type EnrichableChunk,
} from "./chunkMetadataPatches.js";
import type { DocumentShape, TemporalFact } from "./documentEnrichmentContract.js";

export interface DocumentEnrichmentStrategyInput<TChunk extends EnrichableChunk = EnrichableChunk> {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  facts: TemporalFact[];
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

const eventStrategy: DocumentEnrichmentStrategy = {
  shape: "event",
  apply(input) {
    const patches = buildChunkMetadataPatches(
      input.chunks,
      input.facts.filter((fact): fact is Extract<TemporalFact, { kind: "event_date" }> => fact.kind === "event_date"),
    );
    const patchedChunks = applyMetadataPatches(input.chunks, patches);
    return {
      documentMetadata: { ...input.documentMetadata },
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
