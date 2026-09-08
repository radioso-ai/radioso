import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  evaluateStorageCompatibility,
  type StorageCompatibilityInput,
} from "../../../src/modules/appStorage/public.js";

const active = [buildStorageCollection()];

/**
 * The observations a real caller supplies. A declaration alone cannot answer the
 * question, so a case that says nothing about stored rows or queued jobs is
 * saying there are none of either.
 */
const evaluate = (input: Partial<StorageCompatibilityInput> & { candidate: StorageCompatibilityInput["candidate"] }) =>
  evaluateStorageCompatibility({
    active,
    queuedReaderVersions: [],
    storedWriterVersions: [],
    ...input,
  });

const findingCodes = (candidate: ReturnType<typeof buildStorageCollection>[]): string[] =>
  evaluate({ candidate }).findings.map((finding) => finding.code);

describe("evaluateStorageCompatibility", () => {
  it("accepts an identical declaration", () => {
    const report = evaluate({ candidate: [buildStorageCollection()] });
    expect(report).toEqual({ compatible: true, findings: [], requiresIndexRebuild: [] });
  });

  it("accepts a collection the candidate adds", () => {
    const added = buildStorageCollection({ id: "cursors" });
    expect(evaluate({ candidate: [...active, added] }).compatible).toBe(true);
  });

  it("accepts an added optional field, which every older reader may ignore", () => {
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: [
          ...buildStorageCollection().recordSchema.fields,
          { key: "etag", type: "string", required: false },
        ],
      },
    });
    expect(evaluate({ candidate: [candidate] }).compatible).toBe(true);
  });

  it("accepts an added allowed operation", () => {
    const narrow = [buildStorageCollection({ allowedOperations: ["get", "put"] })];
    const candidate = buildStorageCollection({ allowedOperations: ["get", "put", "delete"] });
    expect(evaluate({ active: narrow, candidate: [candidate] }).compatible).toBe(true);
  });

  it("rejects an added required field, because stored records do not carry it", () => {
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: [
          ...buildStorageCollection().recordSchema.fields,
          { key: "etag", type: "string", required: true },
        ],
      },
    });
    expect(findingCodes([candidate])).toContain("required_field_added");
  });

  it("rejects a removed field", () => {
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.filter((field) => field.key !== "sequence"),
      },
    });
    expect(findingCodes([candidate])).toContain("field_removed");
  });

  it("rejects a changed field type", () => {
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, type: "string" as const } : field,
        ),
      },
    });
    expect(findingCodes([candidate])).toContain("field_type_changed");
  });

  it("rejects tightening an optional field into a required one", () => {
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, required: true } : field,
        ),
      },
    });
    expect(findingCodes([candidate])).toContain("field_requirement_tightened");
  });

  it("rejects loosening a required field, which an older reader still expects to be there", () => {
    // The candidate may then write a record without the field; a rollback release
    // or a queued job that requires it reads that record and finds it missing.
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.map((field) =>
          field.key === "external_id" ? { ...field, required: false } : field,
        ),
      },
    });
    expect(findingCodes([candidate])).toContain("field_requirement_loosened");
  });

  it("rejects removing an index a queued job may still query by", () => {
    expect(findingCodes([buildStorageCollection({ indexes: [] })])).toContain("index_removed");
  });

  it("rejects repointing an index at another field", () => {
    const candidate = buildStorageCollection({ indexes: [{ id: "by_external_id", field: "sequence" }] });
    expect(findingCodes([candidate])).toContain("index_field_changed");
  });

  it("rejects narrowing allowedOperations, which turns a queued job's next call into denied", () => {
    const candidate = buildStorageCollection({ allowedOperations: ["get", "put", "delete"] });
    const report = evaluate({ candidate: [candidate] });
    expect(report.findings.map((finding) => finding.code)).toContain("allowed_operation_removed");
    expect(report.findings.some((finding) => finding.detail.includes("query_by_index"))).toBe(true);
  });

  it("rejects dropping a collection whose records the active release stores", () => {
    expect(evaluate({ candidate: [] }).findings.map((finding) => finding.code)).toContain("collection_removed");
  });

  it("rejects a schema version that moves backwards", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 3, compatibleReaderVersions: [1, 2, 3] })];
    const candidate = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2] });
    expect(
      evaluate({ active: laterActive, candidate: [candidate] }).findings.map((finding) => finding.code),
    ).toContain("schema_version_regressed");
  });

  it("rejects reusing a schema version for a different record shape", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: [
          ...buildStorageCollection().recordSchema.fields,
          { key: "etag", type: "string", required: false },
        ],
      },
    });
    expect(findingCodes([candidate])).toContain("schema_version_reused");
  });

  it("rejects dropping the reader version the active release writes", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2, 3] })];
    const candidate = buildStorageCollection({ schemaVersion: 3, compatibleReaderVersions: [3] });
    expect(
      evaluate({ active: laterActive, candidate: [candidate] }).findings.map((finding) => finding.code),
    ).toContain("reader_version_dropped");
  });
});

describe("evaluateStorageCompatibility against stored, queued, and rollback readers", () => {
  it("accepts dropping an obsolete reader version no stored record uses", () => {
    // The contract caps the reader list, so a long-lived App has to drop the
    // oldest entry eventually; what makes that safe is that nothing carries it.
    const laterActive = [buildStorageCollection({ schemaVersion: 8, compatibleReaderVersions: [1, 2, 3, 4, 5, 6, 7, 8] })];
    const candidate = buildStorageCollection({
      schemaVersion: 9,
      compatibleReaderVersions: [2, 3, 4, 5, 6, 7, 8, 9],
    });

    const report = evaluate({
      active: laterActive,
      candidate: [candidate],
      storedWriterVersions: [7, 8],
    });
    expect(report.compatible).toBe(true);
  });

  it("rejects dropping a reader version stored records still carry", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 8, compatibleReaderVersions: [1, 2, 3, 4, 5, 6, 7, 8] })];
    const candidate = buildStorageCollection({
      schemaVersion: 9,
      compatibleReaderVersions: [2, 3, 4, 5, 6, 7, 8, 9],
    });

    const report = evaluate({
      active: laterActive,
      candidate: [candidate],
      storedWriterVersions: [1, 8],
    });
    expect(report.findings.map((finding) => finding.code)).toContain("stored_writer_unreadable");
  });

  it("rejects a candidate a release the operator can roll back to cannot read", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2, 3] })];
    const rollback = [buildStorageCollection({ schemaVersion: 1, compatibleReaderVersions: [1] })];
    // The rollback release does not declare version 3 readable, and the candidate
    // does more than add optional fields to what that release reads.
    const candidate = buildStorageCollection({
      schemaVersion: 3,
      compatibleReaderVersions: [1, 2, 3],
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.filter((field) => field.key !== "sequence"),
      },
    });

    const report = evaluate({ active: laterActive, candidate: [candidate], rollback });
    expect(report.findings.map((finding) => finding.code)).toContain("field_removed");
  });

  it("accepts a rollback release that declared the candidate's version readable", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2, 3] })];
    const rollback = [buildStorageCollection({ schemaVersion: 1, compatibleReaderVersions: [1, 2, 3] })];
    const candidate = buildStorageCollection({ schemaVersion: 3, compatibleReaderVersions: [1, 2, 3] });

    expect(evaluate({ active: laterActive, candidate: [candidate], rollback }).compatible).toBe(true);
  });

  it("rejects a job queued under a version no active or rollback release declares", () => {
    const report = evaluate({ candidate: [buildStorageCollection()], queuedReaderVersions: [1, 4] });
    expect(report.findings.map((finding) => finding.code)).toContain("queued_reader_unknown");
  });

  it("accepts a job queued under the active release's own version", () => {
    expect(evaluate({ candidate: [buildStorageCollection()], queuedReaderVersions: [1] }).compatible).toBe(true);
  });
});

describe("evaluateStorageCompatibility index rebuilds", () => {
  it("reports an added index as a rebuild the activation has to run first", () => {
    // Index entries exist per record, so the added index answers nothing about
    // records the active release wrote until it is built over them.
    const candidate = buildStorageCollection({
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
      ],
    });

    const report = evaluate({ candidate: [candidate] });
    expect(report.compatible).toBe(true);
    expect(report.requiresIndexRebuild).toEqual([{ collectionId: "sync_state", indexId: "by_sequence" }]);
  });

  it("asks for no rebuild when the candidate declares the indexes the active release already has", () => {
    expect(evaluate({ candidate: [buildStorageCollection()] }).requiresIndexRebuild).toEqual([]);
  });

  it("names the collection and the declaration at fault without quoting stored data", () => {
    const [finding] = evaluate({ candidate: [buildStorageCollection({ indexes: [] })] }).findings;
    expect(finding?.collectionId).toBe("sync_state");
    expect(finding?.detail).toContain("by_external_id");
  });
});
