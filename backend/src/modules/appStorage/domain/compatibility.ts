import type { StorageCollection } from "@radioso/app-contract";

/** One declared field of a collection's record schema. */
type StorageRecordField = StorageCollection["recordSchema"]["fields"][number];

/**
 * Why a candidate release cannot read or write what an installed release stored.
 * Each code names a declaration that moved, never a stored value.
 */
type StorageCompatibilityCode =
  | "collection_removed"
  | "collection_mismatch"
  | "field_removed"
  | "field_type_changed"
  | "field_requirement_tightened"
  | "field_requirement_loosened"
  | "required_field_added"
  | "index_removed"
  | "index_field_changed"
  | "allowed_operation_removed"
  | "schema_version_reused"
  | "reader_version_dropped"
  | "stored_writer_unreadable"
  | "candidate_writer_unreadable";

interface StorageCompatibilityFinding {
  code: StorageCompatibilityCode;
  collectionId: string;
  detail: string;
}

/** An index the candidate adds, and the existing records it has to be built over. */
interface StorageIndexRebuild {
  collectionId: string;
  indexId: string;
}

interface StorageCompatibilityReport {
  compatible: boolean;
  findings: StorageCompatibilityFinding[];
  /**
   * Index entries exist per record, so an index a candidate adds finds nothing
   * until it is built over the records already stored. Activation runs
   * `rebuildIndex` for each of these before the candidate serves a query, and the
   * rebuild is also where a value stored before the field was indexed is checked
   * against the index's own bounds.
   */
  requiresIndexRebuild: StorageIndexRebuild[];
}

/**
 * What one collection is checked as. Observations are per collection because they
 * are per collection in the database: collection A can hold records written under
 * version 1 while collection B holds version 2, and a single flat list of versions
 * would have each collection answer for the other's history.
 *
 * `candidate` is `null` when the candidate release stops declaring the collection.
 *
 * `survivingReaders` are the full declarations of every release that can still
 * read this collection once the candidate is activated: the active release during
 * a rolling change, every release the operator could roll back to, and the release
 * each already-enqueued job will be read back under. They are declarations rather
 * than version numbers because the question asked of each of them is whether it
 * can read what the candidate writes, and a bare version number cannot answer it.
 *
 * `storedWriterVersions` is an observation, not a declaration: the versions rows
 * in this collection actually carry. It is authoritative and comes from
 * `AppStorageCompatibilityFactsPort.storedSchemaVersions`, so a caller never has
 * to infer it from what some release declared.
 */
export interface StorageCollectionObservation {
  collectionId: string;
  candidate: StorageCollection | null;
  survivingReaders: readonly StorageCollection[];
  storedWriterVersions: readonly number[];
}

interface StorageCompatibilityInput {
  collections: readonly StorageCollectionObservation[];
}

/**
 * The storage half of release admission and update planning: whether a candidate
 * release can be activated over the records installed releases wrote, without
 * running migration code over them.
 *
 * The matrix is direction-neutral. A rollback is an activation whose candidate
 * carries a lower schema version, and lowering the number is not by itself a
 * defect — what matters is whether every pairing still holds. So a candidate is
 * never rejected for being behind; it is rejected when a pairing fails.
 *
 * Three families of rule decide that, and they are independent of each other.
 *
 * The schema rules are additive-only and hold whatever any release declares. Of
 * two declarations, the one carrying the higher schema version may only add
 * optional fields to the other: removing a field, retyping one, or changing its
 * requiredness changes the meaning of records nobody is going to rewrite. A
 * `compatibleReaderVersions` entry is a claim about which versions a release can
 * parse, and no claim makes a removed field readable, so a declaration cannot
 * waive these.
 *
 * The reader rules run in both directions, and this is the part a one-sided check
 * misses. Forwards: the candidate reads every version stored records carry and
 * every version a surviving reader writes, or activating it makes existing rows
 * unreadable. Backwards: every reader that survives the activation reads what the
 * candidate writes, or the release still serving beside it meets a record it
 * cannot parse. A reader proves the backward direction by declaring the
 * candidate's `schemaVersion` readable, or by differing from the candidate only
 * additively — which is the same proof, made structurally.
 *
 * The rest are access-path rules: a removed index takes away a path a surviving
 * reader may have been planned against, and a narrowed `allowedOperations` turns
 * its next call into `denied`.
 */
export const evaluateStorageCompatibility = (
  input: StorageCompatibilityInput,
): StorageCompatibilityReport => {
  const findings: StorageCompatibilityFinding[] = [];
  const requiresIndexRebuild: StorageIndexRebuild[] = [];

  for (const observation of input.collections) {
    findings.push(...mismatchedDeclarations(observation));

    if (!observation.candidate) {
      findings.push({
        code: "collection_removed",
        collectionId: observation.collectionId,
        detail: `The candidate release does not declare collection ${observation.collectionId}`,
      });
      continue;
    }

    findings.push(...compareCollection(observation, observation.candidate));
    requiresIndexRebuild.push(...addedIndexes(observation, observation.candidate));
  }

  const unique = dedupe(findings);
  return { compatible: unique.length === 0, findings: unique, requiresIndexRebuild };
};

/**
 * An observation names one collection, and every declaration in it has to be that
 * collection's. Otherwise a report attributed to collection A can have been
 * decided by declarations of collection B, and nothing in the result would say so.
 */
const mismatchedDeclarations = (
  observation: StorageCollectionObservation,
): StorageCompatibilityFinding[] => {
  const { collectionId } = observation;
  const declarations = [
    ...(observation.candidate ? [{ role: "candidate", declaration: observation.candidate }] : []),
    ...observation.survivingReaders.map((declaration) => ({ role: "surviving reader", declaration })),
  ];

  return declarations
    .filter((entry) => entry.declaration.id !== collectionId)
    .map((entry) => ({
      code: "collection_mismatch" as const,
      collectionId,
      detail: `A ${entry.role} declaration for collection ${entry.declaration.id} is observed as ${collectionId}`,
    }));
};

const dedupe = (findings: readonly StorageCompatibilityFinding[]): StorageCompatibilityFinding[] => {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const identity = `${finding.code}|${finding.collectionId}|${finding.detail}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

/**
 * The indexes the candidate declares that some surviving reader does not. An
 * index entry only exists because a release that declared it wrote the record, so
 * an index not every surviving reader carries has records with no entry under it.
 */
const addedIndexes = (
  observation: StorageCollectionObservation,
  candidate: StorageCollection,
): StorageIndexRebuild[] =>
  candidate.indexes
    .filter((index) =>
      observation.survivingReaders.some(
        (reader) => !reader.indexes.some((declared) => declared.id === index.id),
      ),
    )
    .map((index) => ({ collectionId: observation.collectionId, indexId: index.id }));

const compareCollection = (
  observation: StorageCollectionObservation,
  candidate: StorageCollection,
): StorageCompatibilityFinding[] => {
  const { collectionId, survivingReaders } = observation;
  const findings: StorageCompatibilityFinding[] = [];
  const at = (code: StorageCompatibilityCode, detail: string): void => {
    findings.push({ code, collectionId, detail });
  };

  for (const reader of survivingReaders) {
    // A schema version is what a reader resolves a record's shape by, so two
    // releases cannot share one and mean different shapes by it.
    if (candidate.schemaVersion === reader.schemaVersion && !sameRecordSchema(reader, candidate)) {
      at(
        "schema_version_reused",
        `The record schema changes while schemaVersion stays at ${candidate.schemaVersion}`,
      );
    }

    // Additive-only, in whichever direction the versions run. Every surviving
    // reader is paired with the candidate, because each of those pairings
    // outlives the activation.
    const schemaFindings = compareSchemas(collectionId, reader, candidate);
    findings.push(...schemaFindings);

    // The backward direction: this reader is still serving after the activation
    // and will meet records the candidate wrote. It proves it can read them by
    // declaring the candidate's version, or by differing from it only additively.
    if (
      !reader.compatibleReaderVersions.includes(candidate.schemaVersion) &&
      schemaFindings.length > 0
    ) {
      at(
        "candidate_writer_unreadable",
        `A surviving reader at version ${reader.schemaVersion} does not read version ${candidate.schemaVersion}, which the candidate writes`,
      );
    }

    // The forward direction for a reader that is also still writing.
    if (!candidate.compatibleReaderVersions.includes(reader.schemaVersion)) {
      at(
        "reader_version_dropped",
        `The candidate does not read version ${reader.schemaVersion}, which a surviving release writes`,
      );
    }

    for (const operation of reader.allowedOperations) {
      if (candidate.allowedOperations.includes(operation)) continue;
      at("allowed_operation_removed", `The candidate no longer allows ${operation}`);
    }

    const candidateIndexes = new Map(candidate.indexes.map((index) => [index.id, index]));
    for (const index of reader.indexes) {
      const next = candidateIndexes.get(index.id);
      if (!next) {
        at("index_removed", `Index ${index.id} is no longer declared`);
        continue;
      }
      if (next.field !== index.field) {
        at("index_field_changed", `Index ${index.id} moves from field ${index.field} to ${next.field}`);
      }
    }
  }

  // The forward direction against what is actually on disk.
  for (const version of new Set(observation.storedWriterVersions)) {
    if (candidate.compatibleReaderVersions.includes(version)) continue;
    at(
      "stored_writer_unreadable",
      `The candidate does not read version ${version}, which stored records carry`,
    );
  }

  return findings;
};

const sameRecordSchema = (left: StorageCollection, right: StorageCollection): boolean => {
  const rightFields = new Map(right.recordSchema.fields.map((field) => [field.key, field]));
  if (rightFields.size !== left.recordSchema.fields.length) return false;
  return left.recordSchema.fields.every((field) => {
    const other = rightFields.get(field.key);
    return other !== undefined && other.type === field.type && other.required === field.required;
  });
};

/**
 * The additive-only rule between two declarations of one collection, applied from
 * the lower-versioned declaration to the higher-versioned one whichever of them is
 * the candidate. The later declaration may add optional fields and nothing else:
 * a field it drops is a value stored records still carry and no reader can
 * resolve, a retyped field is a stored value of the wrong type, a field that
 * becomes required is one every existing record is missing, and a field that
 * becomes optional is one an earlier reader still insists on.
 *
 * Two declarations sharing a version are compared in the same way, with the
 * candidate treated as the later of the two; a shape change under a reused
 * version is reported separately.
 *
 * An empty result is also the structural proof of reader coverage: two
 * declarations that differ only by optional fields can each read the other's
 * records whatever either declares.
 */
const compareSchemas = (
  collectionId: string,
  other: StorageCollection,
  candidate: StorageCollection,
): StorageCompatibilityFinding[] => {
  const [earlier, later] =
    candidate.schemaVersion < other.schemaVersion ? [candidate, other] : [other, candidate];

  const findings: StorageCompatibilityFinding[] = [];
  const laterFields = new Map(later.recordSchema.fields.map((field) => [field.key, field]));

  for (const field of earlier.recordSchema.fields) {
    const next = laterFields.get(field.key);
    if (!next) {
      findings.push({
        code: "field_removed",
        collectionId,
        detail: `Field ${field.key} is no longer declared`,
      });
      continue;
    }
    findings.push(...compareField(collectionId, field, next));
  }

  const earlierFieldKeys = new Set(earlier.recordSchema.fields.map((field) => field.key));
  for (const field of later.recordSchema.fields) {
    if (earlierFieldKeys.has(field.key) || !field.required) continue;
    findings.push({
      code: "required_field_added",
      collectionId,
      detail: `Field ${field.key} is added as required, which stored records do not carry`,
    });
  }

  return findings;
};

const compareField = (
  collectionId: string,
  earlier: StorageRecordField,
  later: StorageRecordField,
): StorageCompatibilityFinding[] => {
  const findings: StorageCompatibilityFinding[] = [];
  if (later.type !== earlier.type) {
    findings.push({
      code: "field_type_changed",
      collectionId,
      detail: `Field ${earlier.key} changes from ${earlier.type} to ${later.type}`,
    });
  }
  if (later.required && !earlier.required) {
    findings.push({
      code: "field_requirement_tightened",
      collectionId,
      detail: `Field ${earlier.key} becomes required`,
    });
  }
  if (!later.required && earlier.required) {
    findings.push({
      code: "field_requirement_loosened",
      collectionId,
      detail: `Field ${earlier.key} becomes optional, which a reader that requires it cannot read`,
    });
  }
  return findings;
};
