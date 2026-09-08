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
  | "schema_version_regressed"
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
   * `rebuildIndex` for each of these before the candidate serves a query.
   */
  requiresIndexRebuild: StorageIndexRebuild[];
}

/**
 * What a candidate release is checked against. Set inclusion between two
 * declarations is not enough: records outlive the release that wrote them, a
 * rollback puts an older release back in front of newer records, and a job
 * enqueued under one schema version is read back under it whatever is active by
 * then.
 *
 * `queuedReaderVersions` and `storedWriterVersions` are observations, not
 * declarations: the schema versions jobs were enqueued under and the schema
 * versions rows actually carry. They describe the collections being evaluated in
 * this call, so a caller holding per-collection observations evaluates one
 * collection at a time.
 */
export interface StorageCompatibilityInput {
  candidate: readonly StorageCollection[];
  active: readonly StorageCollection[];
  /** Declarations of releases an operator can still roll back to. */
  rollback?: readonly StorageCollection[];
  queuedReaderVersions: readonly number[];
  storedWriterVersions: readonly number[];
}

/**
 * The storage half of release admission and update planning: whether a candidate
 * release can be activated over the records installed releases wrote, without
 * running migration code over them.
 *
 * Every pairing has to hold in both directions. The candidate must be able to
 * read what is already stored, which is why its `compatibleReaderVersions` has to
 * cover every version a stored row carries and the version the active release
 * writes. And every reader that outlives the activation — the active release
 * during a rolling change, a release the operator can roll back to, a job already
 * enqueued — must be able to read what the candidate writes, which it can either
 * because it declared the candidate's version readable or because the candidate
 * only added optional fields to what it already reads.
 *
 * Everything else changes the meaning of records nobody is going to rewrite: a
 * removed or retyped field makes stored values unreadable, a newly required field
 * makes every existing record invalid, a loosened one makes a record an older
 * reader still requires disappear, a removed index takes away an access path a
 * queued job may have been planned against, and a narrowed `allowedOperations`
 * turns a queued job's next call into `denied`.
 */
export const evaluateStorageCompatibility = (
  input: StorageCompatibilityInput,
): StorageCompatibilityReport => {
  const candidateById = new Map(input.candidate.map((collection) => [collection.id, collection]));
  const findings: StorageCompatibilityFinding[] = [];
  const requiresIndexRebuild: StorageIndexRebuild[] = [];

  for (const active of input.active) {
    const candidate = candidateById.get(active.id);
    if (!candidate) {
      findings.push({
        code: "collection_removed",
        collectionId: active.id,
        detail: `The candidate release does not declare collection ${active.id}`,
      });
      continue;
    }

    const rollback = (input.rollback ?? []).filter((collection) => collection.id === active.id);
    findings.push(
      ...compareCollections({
        active,
        candidate,
        rollback,
        queuedReaderVersions: input.queuedReaderVersions,
        storedWriterVersions: input.storedWriterVersions,
      }),
    );
    requiresIndexRebuild.push(...addedIndexes(active, candidate));
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

const compareCollections = (input: {
  active: StorageCollection;
  candidate: StorageCollection;
  rollback: readonly StorageCollection[];
  queuedReaderVersions: readonly number[];
  storedWriterVersions: readonly number[];
}): StorageCompatibilityFinding[] => {
  const { active, candidate, rollback } = input;
  const findings: StorageCompatibilityFinding[] = [];
  const at = (code: StorageCompatibilityCode, detail: string): void => {
    findings.push({ code, collectionId: active.id, detail });
  };

  if (candidate.schemaVersion < active.schemaVersion) {
    at(
      "schema_version_regressed",
      `Schema version ${candidate.schemaVersion} is behind the active version ${active.schemaVersion}`,
    );
  }

  // A schema version is what a reader resolves a record's shape by, so two
  // releases cannot share one and mean different shapes by it.
  if (candidate.schemaVersion === active.schemaVersion && !sameRecordSchema(active, candidate)) {
    at(
      "schema_version_reused",
      `The record schema changes while schemaVersion stays at ${candidate.schemaVersion}`,
    );
  }

  // The candidate reads what is already stored.
  for (const version of new Set([...input.storedWriterVersions, active.schemaVersion])) {
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

  // Every reader that outlives the activation reads what the candidate writes.
  const declarations = [active, ...rollback];
  for (const declaration of declarations) {
    findings.push(...readerCanReadCandidate(declaration, candidate));
  }

  const declaredVersions = new Set(declarations.map((declaration) => declaration.schemaVersion));
  for (const queued of new Set(input.queuedReaderVersions)) {
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
 * Whether one declaration can read what the candidate writes. It can when it
 * declared the candidate's version readable, and otherwise only when the
 * candidate's records are still its own records plus fields it may ignore — which
 * means added optional fields and nothing else.
 */
const readerCanReadCandidate = (
  reader: StorageCollection,
  candidate: StorageCollection,
): StorageCompatibilityFinding[] => {
  if (reader.compatibleReaderVersions.includes(candidate.schemaVersion)) return [];

  const findings: StorageCompatibilityFinding[] = [];
  const at = (code: StorageCompatibilityCode, detail: string): void => {
    findings.push({ code, collectionId: candidate.id, detail });
  };

  const candidateFields = new Map(candidate.recordSchema.fields.map((field) => [field.key, field]));
  for (const field of reader.recordSchema.fields) {
    const next = candidateFields.get(field.key);
    if (!next) {
      at("field_removed", `Field ${field.key} is no longer declared`);
      continue;
    }
    findings.push(...compareField(candidate.id, field, next));
  }

  const readerFieldKeys = new Set(reader.recordSchema.fields.map((field) => field.key));
  for (const field of candidate.recordSchema.fields) {
    if (readerFieldKeys.has(field.key) || !field.required) continue;
    at("required_field_added", `Field ${field.key} is added as required, which stored records do not carry`);
  }

  return findings;
};

const compareField = (
  collectionId: string,
  reader: StorageRecordField,
  candidate: StorageRecordField,
): StorageCompatibilityFinding[] => {
  const findings: StorageCompatibilityFinding[] = [];
  if (candidate.type !== reader.type) {
    findings.push({
      code: "field_type_changed",
      collectionId,
      detail: `Field ${reader.key} changes from ${reader.type} to ${candidate.type}`,
    });
  }
  if (candidate.required && !reader.required) {
    findings.push({
      code: "field_requirement_tightened",
      collectionId,
      detail: `Field ${reader.key} becomes required`,
    });
  }
  if (!candidate.required && reader.required) {
    findings.push({
      code: "field_requirement_loosened",
      collectionId,
      detail: `Field ${reader.key} becomes optional, which a reader that requires it cannot read`,
    });
  }
  return findings;
};
