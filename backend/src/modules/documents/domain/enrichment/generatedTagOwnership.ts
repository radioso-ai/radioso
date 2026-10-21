import type { EnrichableChunk } from "./chunkMetadataPatches.js";
import type { DocumentEnrichmentProvenance } from "./documentEnrichmentContract.js";
import { defaultEnabledDocumentTypes } from "./documentTypeMatch.js";
import type {
  DocumentEnrichmentStrategy,
  DocumentEnrichmentStrategyInput,
} from "./enrichmentStrategies.js";

/**
 * Keys the built-in temporal strategies write. They follow the same ownership
 * rule as catalog fields, as a pair: extraction owns them only when a run wrote
 * them, and a date the operator or a connector set keeps both out of reach.
 */
const BUILT_IN_TEMPORAL_KEYS = ["dateFrom", "dateTo"] as const;

/** Pre-migration-120 rows nested provenance inside metadata; it is stripped wherever it is met. */
const LEGACY_PROVENANCE_KEY = "enrichment";

/** Catalog types whose runs carry temporal facts: the built-in entries with a `facts` payload. */
const DATED_TYPE_KEYS: ReadonlySet<string> = new Set(
  defaultEnabledDocumentTypes().types.filter((type) => type.payload === "facts").map((type) => type.key),
);

const isTemporalKey = (key: string): boolean => (BUILT_IN_TEMPORAL_KEYS as readonly string[]).includes(key);

const hasKey = (metadata: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(metadata, key);

const omit = (metadata: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(metadata).filter(([key]) => !keys.has(key)));

/**
 * Provenance without `dateOwnershipRecorded` never listed the dates in
 * `generatedKeys`, so the run it describes is the only evidence of who wrote
 * them: an applied run of a dated type that dated at least one chunk did.
 * Every other case leaves them to the operator. The rule leans that way on
 * purpose — wrongly claiming a date deletes the operator's value on the next
 * re-index, while wrongly leaving one keeps a visible tag they can edit.
 */
const inferredTemporalOwnership = (provenance: DocumentEnrichmentProvenance): boolean =>
  provenance.status === "applied"
  && DATED_TYPE_KEYS.has(provenance.matchedTypeKey ?? provenance.shape ?? "")
  && (provenance.appliedChunkCount ?? 0) > 0;

/** The metadata keys extraction owns on a document, as its provenance records them. */
export const resolveExtractionOwnedKeys = (
  provenance: DocumentEnrichmentProvenance | null | undefined,
): string[] => {
  if (!provenance) {
    return [];
  }
  const generated = provenance.generatedKeys ?? [];
  if (provenance.dateOwnershipRecorded === true || !inferredTemporalOwnership(provenance)) {
    return [...generated];
  }
  return [...new Set([...generated, ...BUILT_IN_TEMPORAL_KEYS])];
};

/**
 * Settles a document's tags for a new revision before it is chunked. When
 * extraction runs on the revision every tag stays: the run replaces the keys it
 * owns only once it succeeds, so a failed run still finds them. When it does
 * not run, extraction-owned keys are cleared, because they describe content
 * nothing will read again, and the provenance that owned them goes with them.
 * Tags the operator or a connector wrote stay in both cases.
 */
export const prepareRevisionTags = (input: {
  metadata: Record<string, unknown>;
  provenance: DocumentEnrichmentProvenance | null;
  extractionEnabled: boolean;
}): { metadata: Record<string, unknown>; clearProvenance: boolean } => {
  if (!input.provenance || input.extractionEnabled) {
    return { metadata: input.metadata, clearProvenance: false };
  }
  return {
    metadata: omit(
      input.metadata,
      new Set<string>([LEGACY_PROVENANCE_KEY, ...resolveExtractionOwnedKeys(input.provenance)]),
    ),
    clearProvenance: true,
  };
};

/** Removes pre-migration-120 nested provenance from a document that has been enriched. */
export const stripLegacyProvenanceTag = (
  metadata: Record<string, unknown>,
  hadEnrichment: boolean,
): Record<string, unknown> => (hadEnrichment ? omit(metadata, new Set<string>([LEGACY_PROVENANCE_KEY])) : metadata);

/**
 * Applies a temporal strategy under the ownership rule. The caller has already
 * removed the keys the previous run owned, so a date still on the document was
 * written by the operator or a connector. Then the strategy writes no date at
 * all — neither on the document nor on any chunk, which keep the operator's
 * dates from the vectorize projection — and each date it would have written
 * counts as a collision. Otherwise the dates it writes become extraction-owned.
 */
export const applyTemporalTagsWithOwnership = <TChunk extends EnrichableChunk>(
  strategy: DocumentEnrichmentStrategy,
  input: DocumentEnrichmentStrategyInput<TChunk>,
): {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  appliedChunkCount: number;
  generatedKeys: string[];
  skippedCollision: number;
} => {
  const operatorDated = BUILT_IN_TEMPORAL_KEYS.some((key) => hasKey(input.documentMetadata, key));
  const result = strategy.apply({
    ...input,
    documentMetadata: omit(input.documentMetadata, new Set<string>(BUILT_IN_TEMPORAL_KEYS)),
  });
  const written = BUILT_IN_TEMPORAL_KEYS.filter((key) => hasKey(result.documentMetadata, key));

  if (operatorDated) {
    return {
      documentMetadata: input.documentMetadata,
      chunks: input.chunks,
      appliedChunkCount: 0,
      generatedKeys: [],
      skippedCollision: written.length,
    };
  }
  return {
    documentMetadata: result.documentMetadata,
    chunks: result.chunks,
    appliedChunkCount: result.appliedChunkCount,
    generatedKeys: [...written],
    skippedCollision: 0,
  };
};

/**
 * A manual metadata write that changes or removes a generated key relinquishes
 * extraction's ownership of it in the same operation: from then on the key is
 * operator-owned, and extraction neither removes nor overwrites it. The dates
 * move as a pair, so a hand-corrected end date never sits beside a start date
 * the next run rewrites.
 *
 * Returns the provenance to persist, or `undefined` when nothing changed and
 * the stored provenance can be left alone.
 */
export const relinquishGeneratedKeys = (input: {
  previousProvenance: DocumentEnrichmentProvenance | null | undefined;
  previousMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
}): DocumentEnrichmentProvenance | undefined => {
  const owned = resolveExtractionOwnedKeys(input.previousProvenance);
  if (!input.previousProvenance || owned.length === 0) {
    return undefined;
  }

  const unchanged = (key: string): boolean =>
    hasKey(input.nextMetadata, key) && Object.is(input.nextMetadata[key], input.previousMetadata[key]);
  const datesRelinquished = owned.some((key) => isTemporalKey(key) && !unchanged(key));
  const retained = owned.filter((key) => unchanged(key) && !(datesRelinquished && isTemporalKey(key)));

  if (retained.length === owned.length) {
    return undefined;
  }
  return { ...input.previousProvenance, generatedKeys: retained, dateOwnershipRecorded: true };
};
