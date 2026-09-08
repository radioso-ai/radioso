import type { StorageCollection } from "@radioso/app-contract";

/** One declared field of a collection's record schema. */
type StorageRecordField = StorageCollection["recordSchema"]["fields"][number];

/**
 * Why a candidate release cannot read or write what an installed release stored.
 * Each code names a declaration that moved, never a stored value.
 */
type StorageCompatibilityCode =
  | "collection_removed"
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
  | "queued_reader_unknown";

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
 * `active` is the declaration serving now; `rollback` holds the declarations of
 * releases an operator can still go back to, which for a rollback admission
 * includes the release being left behind.
 *
 * `queuedReaderVersions` and `storedWriterVersions` are observations, not
 * declarations: the schema versions jobs were enqueued under, and the versions
 * rows in this collection actually carry. The stored side is authoritative and
 * comes from `AppStorageService.storedSchemaVersions`, so a caller never has to
 * infer it from what some release declared.
 */
export interface StorageCollectionObservation {
  collectionId: string;
  candidate: StorageCollection | null;
  active: StorageCollection;
  rollback: readonly StorageCollection[];
  queuedReaderVersions: readonly number[];
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
 * The reader rules are about coverage. The candidate has to read every version
 * stored records carry and the version the active release writes, or activating
 * it makes existing rows unreadable.
 *
 * The rest are access-path rules: a removed index takes away a path a queued job
 * may have been planned against, a narrowed `allowedOperations` turns a queued
 * job's next call into `denied`, and a job queued under a version no release in
 * the picture declares has nothing to be read back by.
 */
export const evaluateStorageCompatibility = (
  input: StorageCompatibilityInput,
): StorageCompatibilityReport => {
  const findings: StorageCompatibilityFinding[] = [];
  const requiresIndexRebuild: StorageIndexRebuild[] = [];

  for (const observation of input.collections) {
    if (!observation.candidate) {
      findings.push({
        code: "collection_removed",
        collectionId: observation.collectionId,
        detail: `The candidate release does not declare collection ${observation.collectionId}`,
      });
      continue;
    }

    findings.push(...compareCollection(observation, observation.candidate));
    requiresIndexRebuild.push(...addedIndexes(observation.active, observation.candidate));
  }

  const unique = dedupe(findings);
  return { compatible: unique.length === 0, findings: unique, requiresIndexRebuild };
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

const addedIndexes = (active: StorageCollection, candidate: StorageCollection): StorageIndexRebuild[] => {
  const activeIndexIds = new Set(active.indexes.map((index) => index.id));
  return candidate.indexes
    .filter((index) => !activeIndexIds.has(index.id))
    .map((index) => ({ collectionId: candidate.id, indexId: index.id }));
};

const compareCollection = (
  observation: StorageCollectionObservation,
  candidate: StorageCollection,
): StorageCompatibilityFinding[] => {
  const { active, rollback, collectionId } = observation;
  const findings: StorageCompatibilityFinding[] = [];
  const at = (code: StorageCompatibilityCode, detail: string): void => {
    findings.push({ code, collectionId, detail });
  };

  // A schema version is what a reader resolves a record's shape by, so two
  // releases cannot share one and mean different shapes by it.
  if (candidate.schemaVersion === active.schemaVersion && !sameRecordSchema(active, candidate)) {
    at(
      "schema_version_reused",
      `The record schema changes while schemaVersion stays at ${candidate.schemaVersion}`,
    );
  }

  // Additive-only, in whichever direction the versions run. The candidate is
  // paired with the active declaration and with every release the operator could
  // still return to, because each of those pairings outlives the activation.
  for (const other of [active, ...rollback]) {
    findings.push(...compareSchemas(collectionId, other, candidate));
  }

  // The candidate reads what is already stored.
  for (const version of new Set([...observation.storedWriterVersions, active.schemaVersion])) {
    if (candidate.compatibleReaderVersions.includes(version)) continue;
    if (version === active.schemaVersion) {
      at(
        "reader_version_dropped",
        `The candidate does not read version ${version}, which the active release writes`,
      );
      continue;
    }
    at("stored_writer_unreadable", `The candidate does not read version ${version}, which stored records carry`);
  }

  const declaredVersions = new Set([active, ...rollback].map((declaration) => declaration.schemaVersion));
  for (const queued of new Set(observation.queuedReaderVersions)) {
    if (queued === candidate.schemaVersion || declaredVersions.has(queued)) continue;
    at(
      "queued_reader_unknown",
      `A job is queued under version ${queued}, which no active or rollback release declares`,
    );
  }

  for (const operation of active.allowedOperations) {
    if (candidate.allowedOperations.includes(operation)) continue;
    at("allowed_operation_removed", `The candidate no longer allows ${operation}`);
  }

  const candidateIndexes = new Map(candidate.indexes.map((index) => [index.id, index]));
  for (const index of active.indexes) {
    const next = candidateIndexes.get(index.id);
    if (!next) {
      at("index_removed", `Index ${index.id} is no longer declared`);
      continue;
    }
    if (next.field !== index.field) {
      at("index_field_changed", `Index ${index.id} moves from field ${index.field} to ${next.field}`);
    }
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
