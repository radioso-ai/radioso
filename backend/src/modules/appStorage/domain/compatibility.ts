import type { StorageCollection } from "@radioso/app-contract";

/**
 * Why a candidate release cannot read or write what the active release stored.
 * Each code names a declaration that moved, never a stored value.
 */
type StorageCompatibilityCode =
  | "collection_removed"
  | "field_removed"
  | "field_type_changed"
  | "field_requirement_tightened"
  | "required_field_added"
  | "index_removed"
  | "index_field_changed"
  | "schema_version_regressed"
  | "reader_version_dropped";

interface StorageCompatibilityFinding {
  code: StorageCompatibilityCode;
  collectionId: string;
  detail: string;
}

interface StorageCompatibilityReport {
  compatible: boolean;
  findings: StorageCompatibilityFinding[];
}

/**
 * The storage half of release admission and update planning: whether a candidate
 * release can be activated over the records an active release wrote, without
 * running migration code over them.
 *
 * The policy is additive-only. A candidate may add a collection, add an optional
 * field, add an index, and widen its allowed operations, because every record
 * already stored still satisfies the declaration. Anything else changes the
 * meaning of records nobody is going to rewrite: a removed or retyped field
 * makes stored values unreadable, a newly required field makes every existing
 * record invalid, and a removed index takes away the only access path a queued
 * job — which retains the schema version it was enqueued under — may have been
 * planned against.
 */
export const evaluateStorageCompatibility = (input: {
  active: readonly StorageCollection[];
  candidate: readonly StorageCollection[];
}): StorageCompatibilityReport => {
  const candidateById = new Map(input.candidate.map((collection) => [collection.id, collection]));
  const findings: StorageCompatibilityFinding[] = [];

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
    findings.push(...compareCollections(active, candidate));
  }

  return { compatible: findings.length === 0, findings };
};

const compareCollections = (
  active: StorageCollection,
  candidate: StorageCollection,
): StorageCompatibilityFinding[] => {
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

  for (const readerVersion of active.compatibleReaderVersions) {
    if (candidate.compatibleReaderVersions.includes(readerVersion)) continue;
    at("reader_version_dropped", `Reader version ${readerVersion} is no longer declared compatible`);
  }

  const candidateFields = new Map(candidate.recordSchema.fields.map((field) => [field.key, field]));
  for (const field of active.recordSchema.fields) {
    const next = candidateFields.get(field.key);
    if (!next) {
      at("field_removed", `Field ${field.key} is no longer declared`);
      continue;
    }
    if (next.type !== field.type) {
      at("field_type_changed", `Field ${field.key} changes from ${field.type} to ${next.type}`);
    }
    if (next.required && !field.required) {
      at("field_requirement_tightened", `Field ${field.key} becomes required`);
    }
  }

  const activeFieldKeys = new Set(active.recordSchema.fields.map((field) => field.key));
  for (const field of candidate.recordSchema.fields) {
    if (activeFieldKeys.has(field.key) || !field.required) continue;
    at("required_field_added", `Field ${field.key} is added as required, which stored records do not carry`);
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
