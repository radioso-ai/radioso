import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { buildRepositoryStub, connectionFailure } from "./repositoryStub.js";
import { createAppStorageIndexRebuilder } from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();
const collection = buildStorageCollection();

/** A batch that found nothing: the shape the closing pass of a settled rebuild returns. */
const emptyBatch = {
  rebuiltCount: 0,
  lastKey: null,
  visitedKeys: [] as string[],
  incompatibleKeys: [] as string[],
};

describe("app storage index rebuild", () => {
  const scope = { workspaceId, installationId, collection, indexId: "by_external_id" };

  it("walks the collection in key-ordered batches until a short one ends the pass", async () => {
    const repository = buildRepositoryStub();
    const batches = [
      { rebuiltCount: 2, lastKey: "post-2", visitedKeys: ["post-1", "post-2"], incompatibleKeys: [] },
      { rebuiltCount: 1, lastKey: "post-3", visitedKeys: ["post-3"], incompatibleKeys: [] },
    ];
    repository.rebuildIndexBatch = vi.fn(async () => ({
      admitted: true as const,
      value: batches.shift() ?? emptyBatch,
    }));

    const result = await createAppStorageIndexRebuilder({ repository, batchSize: 2 }).rebuildIndex(scope);

    // Three records over two batches, then one more batch for the convergence
    // pass that finds nothing written since the marker went up.
    expect(result).toEqual({
      ok: true,
      value: {
        outcome: "rebuilt",
        rebuiltCount: 3,
        batchCount: 3,
        completionToken: "sync_state:by_external_id:1",
      },
    });
    expect(repository.rebuildIndexBatch).toHaveBeenNthCalledWith(1, {
      scope: { workspaceId, installationId, collectionId: "sync_state" },
      index: { id: "by_external_id", field: "external_id", fieldType: "string" },
      after: null,
      limit: 2,
      minVersion: null,
    });
    // The second batch resumes after the last key the first one reached, so the
    // pass never revisits a record it already built.
    expect(repository.rebuildIndexBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: "post-2" }));
  });

  it("marks the index pending before the first batch and finishes under its own generation", async () => {
    // While the marker is up, every put maintains an entry for this index as well
    // as for the ones its own release declares. Without it, an older release that
    // rewrites a key the first pass already visited silently drops the entry. The
    // marker stays up past the last batch: it is activation that takes it down.
    const repository = buildRepositoryStub();
    const order: string[] = [];
    repository.beginIndexRebuild = vi.fn(async () => {
      order.push("begin");
      return { admitted: true as const, value: { startVersion: 41, generation: 7 } };
    });
    repository.rebuildIndexBatch = vi.fn(async () => {
      order.push("batch");
      return { admitted: true as const, value: emptyBatch };
    });
    repository.finishIndexRebuild = vi.fn(async () => {
      order.push("finish");
      return {
        admitted: true as const,
        value: { outcome: "finished" as const, completionToken: "sync_state:by_external_id:7" },
      };
    });

    await createAppStorageIndexRebuilder({ repository }).rebuildIndex(scope);

    expect(order).toEqual(["begin", "batch", "batch", "finish"]);
    expect(repository.finishIndexRebuild).toHaveBeenCalledWith({
      scope: { workspaceId, installationId, collectionId: "sync_state" },
      indexId: "by_external_id",
      generation: 7,
    });
  });

  it("reports a rebuild another run took over rather than claiming a completion it does not own", async () => {
    const repository = buildRepositoryStub();
    repository.finishIndexRebuild = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "stale" as const },
    }));

    await expect(
      createAppStorageIndexRebuilder({ repository }).rebuildIndex(scope),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: "superseded", indexId: "by_external_id" },
    });
  });

  it("closes with a pass over only the records written since the marker went up", async () => {
    // The batches run one transaction at a time, so a write can land behind the
    // cursor while they are running. Every such write carries a version at or
    // past the marker, which is exactly what this pass revisits.
    const repository = buildRepositoryStub();
    repository.beginIndexRebuild = vi.fn(async () => ({
      admitted: true as const,
      value: { startVersion: 77, generation: 1 },
    }));
    const batches = [
      { rebuiltCount: 2, lastKey: "post-2", visitedKeys: ["a", "b"], incompatibleKeys: [] },
      { rebuiltCount: 0, lastKey: null, visitedKeys: [], incompatibleKeys: [] },
      { rebuiltCount: 2, lastKey: "post-9", visitedKeys: ["c", "d"], incompatibleKeys: [] },
      { rebuiltCount: 0, lastKey: null, visitedKeys: [], incompatibleKeys: [] },
    ];
    repository.rebuildIndexBatch = vi.fn(async () => ({
      admitted: true as const,
      value: batches.shift() ?? emptyBatch,
    }));

    await createAppStorageIndexRebuilder({ repository, batchSize: 2 }).rebuildIndex(scope);

    const calls = (repository.rebuildIndexBatch as ReturnType<typeof vi.fn>).mock.calls.map(
      ([batch]) => batch.minVersion,
    );
    expect(calls).toEqual([null, null, 77, 77]);
  });

  it("reports a value the index cannot hold instead of activating a query that skips it", async () => {
    // A field stored before it was indexed was never measured against the index's
    // bounds. The rebuild will not be activated, so it takes its own marker down
    // rather than leaving every future write maintaining an index nobody queries.
    const repository = buildRepositoryStub();
    repository.rebuildIndexBatch = vi.fn(async () => ({
      admitted: true as const,
      value: { rebuiltCount: 1, lastKey: null, visitedKeys: ["huge"], incompatibleKeys: ["huge"] },
    }));

    const result = await createAppStorageIndexRebuilder({ repository }).rebuildIndex(scope);

    expect(result).toEqual({
      ok: true,
      value: { outcome: "incompatible_records", indexId: "by_external_id", incompatibleCount: 1 },
    });
    expect(repository.finishIndexRebuild).not.toHaveBeenCalled();
    expect(repository.cancelIndexRebuild).toHaveBeenCalledWith({
      scope: { workspaceId, installationId, collectionId: "sync_state" },
      indexId: "by_external_id",
      generation: 1,
    });
  });

  it("judges compatibility by the latest look at each record, not by an accumulated count", async () => {
    // A record that was past the index bound in the first pass and was corrected
    // before the convergence pass is not a reason to refuse the candidate: the
    // value it was refused for is no longer there.
    const repository = buildRepositoryStub();
    const batches = [
      { rebuiltCount: 1, lastKey: null, visitedKeys: ["fixed"], incompatibleKeys: ["fixed"] },
      { rebuiltCount: 1, lastKey: null, visitedKeys: ["fixed"], incompatibleKeys: [] },
    ];
    repository.rebuildIndexBatch = vi.fn(async () => ({
      admitted: true as const,
      value: batches.shift() ?? emptyBatch,
    }));

    await expect(
      createAppStorageIndexRebuilder({ repository }).rebuildIndex(scope),
    ).resolves.toMatchObject({ ok: true, value: { outcome: "rebuilt" } });
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
      value: { rebuiltCount: 2, lastKey: "post-2", visitedKeys: ["a", "b"], incompatibleKeys: [] },
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
