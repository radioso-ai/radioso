import { describe, expect, it } from "vitest";
import type { StorageCollection } from "@radioso/app-contract";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  evaluateStorageCompatibility,
  type StorageCollectionObservation,
} from "../../../src/modules/appStorage/public.js";

const base = buildStorageCollection();

/**
 * One collection's observation. Everything except the candidate has a default,
 * because a case that says nothing about rollback releases, queued jobs, or
 * stored rows is saying there are none of those — not that they are unknown.
 */
const observe = (
  input: Partial<StorageCollectionObservation> & { candidate: StorageCollection | null },
): StorageCollectionObservation => ({
  collectionId: input.candidate?.id ?? input.active?.id ?? base.id,
  active: base,
  rollback: [],
  queuedReaderVersions: [],
  storedWriterVersions: [],
  ...input,
});

const evaluate = (
  input: Partial<StorageCollectionObservation> & { candidate: StorageCollection | null },
) => evaluateStorageCompatibility({ collections: [observe(input)] });

const findingCodes = (candidate: StorageCollection): string[] =>
  evaluate({ candidate }).findings.map((finding) => finding.code);

/** The same collection at a later version, with the readers such a release declares. */
const atVersion = (schemaVersion: number, overrides: Partial<StorageCollection> = {}): StorageCollection =>
  buildStorageCollection({
    schemaVersion,
    compatibleReaderVersions: Array.from({ length: schemaVersion }, (_unused, index) => index + 1),
    ...overrides,
  });

describe("evaluateStorageCompatibility", () => {
  it("accepts an identical declaration", () => {
    expect(evaluate({ candidate: buildStorageCollection() })).toEqual({
      compatible: true,
      findings: [],
      requiresIndexRebuild: [],
    });
  });

  it("accepts an added optional field, which every older reader may ignore", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: false }],
      },
    });
    expect(evaluate({ candidate }).compatible).toBe(true);
  });

  it("accepts an added allowed operation", () => {
    const candidate = buildStorageCollection({ allowedOperations: ["get", "put", "delete"] });
    const active = buildStorageCollection({ allowedOperations: ["get", "put"] });
    expect(evaluate({ active, candidate }).compatible).toBe(true);
  });

  it("rejects an added required field, because stored records do not carry it", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: true }],
      },
    });
    expect(findingCodes(candidate)).toContain("required_field_added");
  });

  it("rejects a removed field", () => {
    const candidate = atVersion(2, {
      recordSchema: { fields: base.recordSchema.fields.filter((field) => field.key !== "sequence") },
    });
    expect(findingCodes(candidate)).toContain("field_removed");
  });

  it("rejects a changed field type", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, type: "string" as const } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_type_changed");
  });

  it("rejects tightening an optional field into a required one", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, required: true } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_requirement_tightened");
  });

  it("rejects loosening a required field, which an older reader still expects to be there", () => {
    // The candidate may then write a record without the field; a rollback release
    // or a queued job that requires it reads that record and finds it missing.
    const candidate = atVersion(2, {
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "external_id" ? { ...field, required: false } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_requirement_loosened");
  });

  it("rejects removing an index a queued job may still query by", () => {
    expect(findingCodes(buildStorageCollection({ indexes: [] }))).toContain("index_removed");
  });

  it("rejects repointing an index at another field", () => {
    const candidate = buildStorageCollection({ indexes: [{ id: "by_external_id", field: "sequence" }] });
    expect(findingCodes(candidate)).toContain("index_field_changed");
  });

  it("rejects narrowing allowedOperations, which turns a queued job's next call into denied", () => {
    const candidate = buildStorageCollection({ allowedOperations: ["get", "put", "delete"] });
    const report = evaluate({ candidate });
    expect(report.findings.map((finding) => finding.code)).toContain("allowed_operation_removed");
    expect(report.findings.some((finding) => finding.detail.includes("query_by_index"))).toBe(true);
  });

  it("rejects dropping a collection whose records the active release stores", () => {
    expect(evaluate({ candidate: null }).findings.map((finding) => finding.code)).toContain(
      "collection_removed",
    );
  });

  it("rejects reusing a schema version for a different record shape", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: false }],
      },
    });
    expect(findingCodes(candidate)).toContain("schema_version_reused");
  });

  it("rejects dropping the reader version the active release writes", () => {
    const active = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2, 3] });
    const candidate = buildStorageCollection({ schemaVersion: 3, compatibleReaderVersions: [3] });
    expect(evaluate({ active, candidate }).findings.map((finding) => finding.code)).toContain(
      "reader_version_dropped",
    );
  });
});

/**
 * The rules are three independent families, and a declaration belongs to exactly
 * one of them. `compatibleReaderVersions` is a claim about what a release can
 * parse; it establishes coverage and waives nothing, because no claim makes a
 * removed field readable.
 */
describe("evaluateStorageCompatibility additive-only rules", () => {
  it("rejects a removed field even when the candidate declares the active version readable", () => {
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: { fields: base.recordSchema.fields.filter((field) => field.key !== "sequence") },
    });
    expect(findingCodes(candidate)).toContain("field_removed");
  });

  it("rejects a retyped field even when every version in the picture is declared readable", () => {
    const active = buildStorageCollection({ compatibleReaderVersions: [1, 2] });
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, type: "string" as const } : field,
        ),
      },
    });
    expect(evaluate({ active, candidate }).findings.map((finding) => finding.code)).toContain(
      "field_type_changed",
    );
  });

  it("rejects a requiredness change even when the candidate declares the active version readable", () => {
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "external_id" ? { ...field, required: false } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_requirement_loosened");
  });
});

/**
 * A rollback is an activation whose candidate carries a lower schema version.
 * Lowering the number is not by itself a defect — what decides it is whether
 * every pairing still holds.
 */
describe("evaluateStorageCompatibility rollback", () => {
  it("accepts rolling back to a release that reads what is stored and what is active", () => {
    const active = atVersion(3);
    const candidate = atVersion(2, { compatibleReaderVersions: [1, 2, 3] });

    const report = evaluate({
      active,
      candidate,
      rollback: [active],
      storedWriterVersions: [2, 3],
    });
    expect(report).toEqual({ compatible: true, findings: [], requiresIndexRebuild: [] });
  });

  it("rejects rolling back to a release that cannot read what earlier releases stored", () => {
    const active = atVersion(4);
    const candidate = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2] });

    const report = evaluate({ active, candidate, rollback: [active], storedWriterVersions: [3] });
    expect(report.findings.map((finding) => finding.code)).toContain("stored_writer_unreadable");
  });

  it("rejects rolling back past a field the later release added as required", () => {
    const active = atVersion(3, {
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: true }],
      },
    });
    const candidate = atVersion(2, { compatibleReaderVersions: [1, 2, 3] });

    const report = evaluate({ active, candidate, rollback: [active] });
    expect(report.findings.map((finding) => finding.code)).toContain("required_field_added");
  });
});

describe("evaluateStorageCompatibility against stored, queued, and rollback readers", () => {
  it("accepts dropping an obsolete reader version no stored record uses", () => {
    // The contract caps the reader list, so a long-lived App has to drop the
    // oldest entry eventually; what makes that safe is that nothing carries it.
    const active = atVersion(8);
    const candidate = buildStorageCollection({
      schemaVersion: 9,
      compatibleReaderVersions: [2, 3, 4, 5, 6, 7, 8, 9],
    });

    expect(evaluate({ active, candidate, storedWriterVersions: [7, 8] }).compatible).toBe(true);
  });

  it("rejects dropping a reader version stored records still carry", () => {
    const active = atVersion(8);
    const candidate = buildStorageCollection({
      schemaVersion: 9,
      compatibleReaderVersions: [2, 3, 4, 5, 6, 7, 8, 9],
    });

    expect(
      evaluate({ active, candidate, storedWriterVersions: [1, 8] }).findings.map((f) => f.code),
    ).toContain("stored_writer_unreadable");
  });

  it("charges each collection only with the versions its own rows carry", () => {
    // Collection A holds version 1 and collection B holds version 2. A flat list
    // of versions would make each answer for the other's history and reject a
    // candidate that is fine for both.
    const readsOne = buildStorageCollection({ id: "sync_state", compatibleReaderVersions: [1] });
    const readsTwo = buildStorageCollection({
      id: "cursors",
      schemaVersion: 2,
      compatibleReaderVersions: [2],
    });

    const report = evaluateStorageCompatibility({
      collections: [
        observe({ collectionId: "sync_state", active: readsOne, candidate: readsOne, storedWriterVersions: [1] }),
        observe({ collectionId: "cursors", active: readsTwo, candidate: readsTwo, storedWriterVersions: [2] }),
      ],
    });

    expect(report.compatible).toBe(true);
  });

  it("rejects a job queued under a version no active or rollback release declares", () => {
    const report = evaluate({ candidate: buildStorageCollection(), queuedReaderVersions: [1, 4] });
    expect(report.findings.map((finding) => finding.code)).toContain("queued_reader_unknown");
  });

  it("accepts a job queued under the active release's own version", () => {
    expect(
      evaluate({ candidate: buildStorageCollection(), queuedReaderVersions: [1] }).compatible,
    ).toBe(true);
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

    const report = evaluate({ candidate });
    expect(report.compatible).toBe(true);
    expect(report.requiresIndexRebuild).toEqual([{ collectionId: "sync_state", indexId: "by_sequence" }]);
  });

  it("asks for no rebuild when the candidate declares the indexes the active release already has", () => {
    expect(evaluate({ candidate: buildStorageCollection() }).requiresIndexRebuild).toEqual([]);
  });

  it("names the collection and the declaration at fault without quoting stored data", () => {
    const [finding] = evaluate({ candidate: buildStorageCollection({ indexes: [] }) }).findings;
    expect(finding?.collectionId).toBe("sync_state");
    expect(finding?.detail).toContain("by_external_id");
  });
});
