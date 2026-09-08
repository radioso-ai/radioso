import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { buildRepositoryStub, connectionFailure } from "./repositoryStub.js";
import { createAppStorageIndexRebuilder } from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();
const collection = buildStorageCollection();

describe("app storage index rebuild", () => {
  const scope = { workspaceId, installationId, collection, indexId: "by_external_id" };

  it("walks the collection in key-ordered batches until a short one ends the rebuild", async () => {
    const repository = buildRepositoryStub();
    const batches = [
      { rebuiltCount: 2, lastKey: "post-2" },
      { rebuiltCount: 1, lastKey: "post-3" },
    ];
    repository.rebuildIndexBatch = vi.fn(async () => ({
      admitted: true as const,
      value: batches.shift() ?? { rebuiltCount: 0, lastKey: null },
    }));

    const result = await createAppStorageIndexRebuilder({ repository, batchSize: 2 }).rebuildIndex(scope);

    expect(result).toEqual({ ok: true, value: { rebuiltCount: 3, batchCount: 2 } });
    expect(repository.rebuildIndexBatch).toHaveBeenNthCalledWith(1, {
      scope: { workspaceId, installationId, collectionId: "sync_state" },
      index: { id: "by_external_id", field: "external_id", fieldType: "string" },
      after: null,
      limit: 2,
    });
    // The second batch resumes after the last key the first one reached, so the
    // rebuild holds no cursor in the database and never revisits a record.
    expect(repository.rebuildIndexBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: "post-2" }));
  });

  it("derives the entry column from the declared field type rather than from any App's data", async () => {
    const repository = buildRepositoryStub();
    const numeric = buildStorageCollection({ indexes: [{ id: "by_sequence", field: "sequence" }] });

    await createAppStorageIndexRebuilder({ repository }).rebuildIndex({
      workspaceId,
      installationId,
      collection: numeric,
      indexId: "by_sequence",
    });

    expect(repository.rebuildIndexBatch).toHaveBeenCalledWith(
      expect.objectContaining({ index: { id: "by_sequence", field: "sequence", fieldType: "number" } }),
    );
  });

  it("refuses an index the collection does not declare", async () => {
    const repository = buildRepositoryStub();
    const result = await createAppStorageIndexRebuilder({ repository }).rebuildIndex({
      ...scope,
      indexId: "by_nothing",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(repository.rebuildIndexBatch).not.toHaveBeenCalled();
  });

  it("refuses an index naming a field no entry column can carry", async () => {
    const repository = buildRepositoryStub();
    const jsonIndexed = buildStorageCollection({ indexes: [{ id: "by_payload", field: "payload" }] });

    const result = await createAppStorageIndexRebuilder({ repository }).rebuildIndex({
      workspaceId,
      installationId,
      collection: jsonIndexed,
      indexId: "by_payload",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(repository.rebuildIndexBatch).not.toHaveBeenCalled();
  });

  it("refuses a rebuild against an installation the tombstone covers", async () => {
    const repository = buildRepositoryStub();
    repository.rebuildIndexBatch = vi.fn(async () => ({ admitted: false as const }));

    await expect(
      createAppStorageIndexRebuilder({ repository }).rebuildIndex(scope),
    ).resolves.toMatchObject({ ok: false, error: { code: "denied" } });
  });

  it("stops at the batch ceiling instead of rebuilding without bound", async () => {
    const repository = buildRepositoryStub();
    repository.rebuildIndexBatch = vi.fn(async () => ({
      admitted: true as const,
      value: { rebuiltCount: 2, lastKey: "post-2" },
    }));

    await expect(
      createAppStorageIndexRebuilder({ repository, batchSize: 2, maxBatches: 3 }).rebuildIndex(scope),
    ).resolves.toMatchObject({ ok: false, error: { code: "internal" } });
    expect(repository.rebuildIndexBatch).toHaveBeenCalledTimes(3);
  });

  it("turns a database failure into a typed result rather than a rejected promise", async () => {
    const repository = buildRepositoryStub();
    repository.rebuildIndexBatch = vi.fn(async () => {
      throw connectionFailure();
    });

    await expect(
      createAppStorageIndexRebuilder({ repository }).rebuildIndex(scope),
    ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
