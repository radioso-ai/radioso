import type { DocumentEnrichmentProvenance } from "./documentEnrichmentContract.js";

/**
 * Keys the built-in temporal strategies own. They are deliberately not part of
 * the generated-key set: they keep their shipped semantics of being replaced by
 * every run that has extraction enabled, so hand-edited dates persist only
 * until the next run.
 */
const BUILT_IN_TEMPORAL_KEYS = ["dateFrom", "dateTo"] as const;

/** Pre-migration-120 rows nested provenance inside metadata; it is stripped wherever it is met. */
const LEGACY_PROVENANCE_KEY = "enrichment";

const omit = (metadata: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(metadata).filter(([key]) => !keys.has(key)));

/**
 * Clears the tags the built-in temporal lane owns. A document that has never
 * been enriched keeps hand-authored dates untouched.
 */
export const stripBuiltInTemporalTags = (
  metadata: Record<string, unknown>,
  hadEnrichment: boolean,
): Record<string, unknown> => {
  if (!hadEnrichment) {
    return metadata;
  }
  return omit(metadata, new Set<string>([LEGACY_PROVENANCE_KEY, ...BUILT_IN_TEMPORAL_KEYS]));
};

export const readGeneratedKeys = (provenance: unknown): string[] => {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return [];
  }
  const keys = (provenance as { generatedKeys?: unknown }).generatedKeys;
  if (!Array.isArray(keys)) {
    return [];
  }
  return keys.filter((key): key is string => typeof key === "string");
};

/**
 * Clears every tag the last successful run produced, driven by the recorded
 * generated-key set rather than a hard-coded key list. Used when a new document
 * revision invalidates extracted tags: the content they described has changed.
 */
/**
 * A manual metadata write that changes or removes a generated key relinquishes
 * extraction's ownership of it in the same operation: from then on the key is
 * operator-owned, and extraction neither removes nor overwrites it.
 *
 * Returns the provenance to persist, or `undefined` when nothing changed and
 * the stored provenance can be left alone.
 */
export const relinquishGeneratedKeys = (input: {
  previousProvenance: DocumentEnrichmentProvenance | null | undefined;
  previousMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
}): DocumentEnrichmentProvenance | undefined => {
  const generatedKeys = input.previousProvenance?.generatedKeys ?? [];
  if (!input.previousProvenance || generatedKeys.length === 0) {
    return undefined;
  }

  const retained = generatedKeys.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(input.nextMetadata, key)) {
      return false;
    }
    return Object.is(input.nextMetadata[key], input.previousMetadata[key]);
  });

  if (retained.length === generatedKeys.length) {
    return undefined;
  }
  return { ...input.previousProvenance, generatedKeys: retained };
};

export const stripGeneratedEnrichmentTags = (
  metadata: Record<string, unknown>,
  previousProvenance: DocumentEnrichmentProvenance | Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  if (!previousProvenance) {
    return metadata;
  }
  return omit(
    metadata,
    new Set<string>([
      LEGACY_PROVENANCE_KEY,
      ...BUILT_IN_TEMPORAL_KEYS,
      ...readGeneratedKeys(previousProvenance),
    ]),
  );
};
