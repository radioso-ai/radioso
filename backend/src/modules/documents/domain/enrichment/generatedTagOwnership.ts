import { builtInDateFieldKeys, datedDocumentTypeKeys } from "../../../documentTypes/public.js";
import type { EnrichableChunk } from "./chunkMetadataPatches.js";
import type { DocumentEnrichmentProvenance } from "./documentEnrichmentContract.js";
import type {
  DocumentEnrichmentStrategy,
  DocumentEnrichmentStrategyInput,
} from "./enrichmentStrategies.js";
import { hasOwnKey, holdsValue, omitKeys, pickKeys } from "./metadataTags.js";

/**
 * The built-in date keys follow the same ownership rule as catalog fields, as
 * a pair: extraction owns them only when a run wrote them, and a date the
 * operator, an API client, or the document's source tags set keeps both out
 * of reach.
 */
const DATE_KEYS: ReadonlySet<string> = new Set(builtInDateFieldKeys);
const DATED_TYPE_KEYS: ReadonlySet<string> = new Set(datedDocumentTypeKeys);

/** Pre-migration-120 rows nested provenance inside metadata; it is stripped wherever it is met. */
const LEGACY_PROVENANCE_KEY = "enrichment";

/**
 * Connectors rewrite a document's metadata from their upstream system on every
 * sync, so a date one writes — WordPress's publish day, for instance — is a
 * default the upstream derived rather than a date someone chose for this
 * document. Every other source holds documents an operator or an API client
 * filed, whose dates are theirs.
 */
const DATE_SYNCING_SOURCE_KINDS: ReadonlySet<string> = new Set(["connector"]);

export const sourceSyncsDocumentDates = (sourceKind: string | null | undefined): boolean =>
  typeof sourceKind === "string" && DATE_SYNCING_SOURCE_KINDS.has(sourceKind);

const carriesDates = (metadata: Record<string, unknown> | undefined): boolean =>
  builtInDateFieldKeys.some((key) => holdsValue(metadata, key));

/**
 * Provenance without `dateOwnershipRecorded` never listed the dates in
 * `generatedKeys`, so the run it describes is the only evidence of who wrote
 * them: an applied run of a dated type that dated at least one chunk did.
 * Every other case leaves them to the operator. The rule leans that way on
 * purpose — wrongly claiming a date deletes the operator's value on the next
 * re-index, while wrongly leaving one keeps a visible tag they can edit.
 */
const inferredDateOwnership = (provenance: DocumentEnrichmentProvenance): boolean =>
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
  if (provenance.dateOwnershipRecorded === true || !inferredDateOwnership(provenance)) {
    return [...generated];
  }
  return [...new Set([...generated, ...builtInDateFieldKeys])];
};

/**
 * Settles a document's tags for a new revision, between chunking and the chunk
 * projection.
 *
 * The chunks never carry extraction-owned keys: those describe the previous
 * revision's content, and an enrich run patches chunk metadata but not the
 * search text or vectors built from the projection, so a key projected now
 * would outlive the run that replaces it. The enrich run writes them back on
 * success.
 *
 * The document keeps them when extraction runs on the revision: the run
 * removes the keys it owns only once it succeeds, so a failed run still finds
 * them and their provenance. When extraction does not run, `clearedDocument`
 * carries the metadata to persist without them, alongside dropping the
 * provenance that owned them, because nothing will refresh them. Tags the
 * operator or a connector wrote stay everywhere.
 */
export const prepareRevisionTags = (input: {
  metadata: Record<string, unknown>;
  provenance: DocumentEnrichmentProvenance | null;
  extractionEnabled: boolean;
}): {
  projectedMetadata: Record<string, unknown>;
  clearedDocument?: { metadata: Record<string, unknown> };
} => {
  if (!input.provenance) {
    return { projectedMetadata: input.metadata };
  }
  const withoutOwnedKeys = omitKeys(
    input.metadata,
    new Set([LEGACY_PROVENANCE_KEY, ...resolveExtractionOwnedKeys(input.provenance)]),
  );
  return input.extractionEnabled
    ? { projectedMetadata: withoutOwnedKeys }
    : { projectedMetadata: withoutOwnedKeys, clearedDocument: { metadata: withoutOwnedKeys } };
};

/** Removes pre-migration-120 nested provenance from a document that has been enriched. */
export const stripLegacyProvenanceTag = (
  metadata: Record<string, unknown>,
  hadEnrichment: boolean,
): Record<string, unknown> => (hadEnrichment ? omitKeys(metadata, new Set([LEGACY_PROVENANCE_KEY])) : metadata);

/**
 * Applies a temporal strategy under the ownership rule. The caller has already
 * removed the keys the previous run owned, so a date still on the document was
 * written by the operator, an API client, or a connector, and a date in
 * `sourceMetadata` is one the document's source tags stamp on every chunk.
 *
 * An operator's or a source tag's date makes the run write no date at all —
 * neither on the document nor on any chunk, which keep those dates from the
 * chunk projection — and each date it would have written counts as a
 * collision. A date a syncing connector wrote (`documentDatesAreSyncDefaults`)
 * is a default instead: a run that reads dates replaces it on the document and
 * on every chunk, and a run that reads none leaves it standing. Either way the
 * dates a run writes become extraction-owned.
 */
export const applyTemporalTagsWithOwnership = <TChunk extends EnrichableChunk>(
  strategy: DocumentEnrichmentStrategy,
  input: DocumentEnrichmentStrategyInput<TChunk>,
  context: { sourceMetadata?: Record<string, unknown>; documentDatesAreSyncDefaults?: boolean } = {},
): {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  appliedChunkCount: number;
  generatedKeys: string[];
  skippedCollision: number;
} => {
  const operatorDated =
    (context.documentDatesAreSyncDefaults !== true && carriesDates(input.documentMetadata))
    || carriesDates(context.sourceMetadata);
  // Nothing on a chunk outranks the run here, so its date tags start from the
  // source layer: a replaced default leaves no chunk carrying it.
  const sourceDates = pickKeys(context.sourceMetadata, DATE_KEYS);
  const result = strategy.apply({
    ...input,
    documentMetadata: omitKeys(input.documentMetadata, DATE_KEYS),
    chunks: input.chunks.map((chunk) => ({
      ...chunk,
      metadata: { ...omitKeys(chunk.metadata ?? {}, DATE_KEYS), ...sourceDates },
    })),
  });
  const written = builtInDateFieldKeys.filter((key) => holdsValue(result.documentMetadata, key));

  if (operatorDated || written.length === 0) {
    return {
      documentMetadata: input.documentMetadata,
      chunks: input.chunks,
      appliedChunkCount: 0,
      generatedKeys: [],
      skippedCollision: operatorDated ? written.length : 0,
    };
  }
  return {
    documentMetadata: result.documentMetadata,
    chunks: result.chunks,
    appliedChunkCount: result.appliedChunkCount,
    generatedKeys: written,
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
 * Provenance that never recorded date ownership also hands the dates over when
 * a save that leaves the content alone supplies either one, even unchanged:
 * extraction's claim on them is only inferred, and an operator sending dates
 * for unchanged content is the clearest sign they are theirs. A save that
 * changes the content and echoes the dates leaves them with extraction, so
 * the run on the new content re-derives them.
 *
 * Returns the provenance to persist, or `undefined` when nothing changed and
 * the stored provenance can be left alone.
 */
export const relinquishGeneratedKeys = (input: {
  previousProvenance: DocumentEnrichmentProvenance | null | undefined;
  previousMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
  contentChanged: boolean;
}): DocumentEnrichmentProvenance | undefined => {
  const owned = resolveExtractionOwnedKeys(input.previousProvenance);
  if (!input.previousProvenance || owned.length === 0) {
    return undefined;
  }

  const unchanged = (key: string): boolean =>
    hasOwnKey(input.nextMetadata, key) && Object.is(input.nextMetadata[key], input.previousMetadata[key]);
  const datesClaimedOverInference =
    input.previousProvenance.dateOwnershipRecorded !== true
    && !input.contentChanged
    && carriesDates(input.nextMetadata);
  const datesRelinquished =
    datesClaimedOverInference || owned.some((key) => DATE_KEYS.has(key) && !unchanged(key));
  const retained = owned.filter((key) => unchanged(key) && !(datesRelinquished && DATE_KEYS.has(key)));

  if (retained.length === owned.length) {
    return undefined;
  }
  return { ...input.previousProvenance, generatedKeys: retained, dateOwnershipRecorded: true };
};

/**
 * Provenance as the document API publishes it. `generatedKeys` lists every key
 * extraction owns, dates included, so the stored ownership marker that makes
 * that list complete stays internal. Provenance that owns nothing and never
 * listed keys is published as stored.
 */
export const publishEnrichmentProvenance = (
  provenance: DocumentEnrichmentProvenance | null | undefined,
): DocumentEnrichmentProvenance | null => {
  if (!provenance) {
    return null;
  }
  const { dateOwnershipRecorded: _internalMarker, ...published } = provenance;
  const owned = resolveExtractionOwnedKeys(provenance);
  return provenance.generatedKeys === undefined && owned.length === 0
    ? published
    : { ...published, generatedKeys: owned };
};
