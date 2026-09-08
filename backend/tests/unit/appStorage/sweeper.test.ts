import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildRepositoryStub, statementFailure } from "./repositoryStub.js";
import {
  createAppStorageSweeper,
  type AppStorageAuditPort,
  type AppStorageCollectionScope,
} from "../../../src/modules/appStorage/public.js";
import type { AppStorageInstallationScope } from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();

const collectionScope = (collectionId: string): AppStorageCollectionScope => ({
  workspaceId,
  installationId,
  collectionId,
});

const buildAudit = (): AppStorageAuditPort & { record: ReturnType<typeof vi.fn> } => ({
  record: vi.fn(async () => undefined),
});

describe("app storage expiry sweep", () => {
  it("reclaims one collection at a time and stops when a round reclaims nothing", async () => {
    const repository = buildRepositoryStub();
    const listed = [[collectionScope("sync_state"), collectionScope("cursors")], []];
    repository.listCollectionsWithExpiredRecords = vi.fn(async () => listed.shift() ?? []);
    const reclaimed = [50, 7];
    repository.reclaimExpiredRecords = vi.fn(async () => reclaimed.shift() ?? 0);

    const sweeper = createAppStorageSweeper({
      repository,
      audit: buildAudit(),
      batchSize: 50,
      maxBatches: 10,
    });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 57, batchCount: 2 });
    // Each batch names a collection, because the counter row it locks first is the
    // collection's; a sweep across collections would take locks a write does not.
    expect(repository.reclaimExpiredRecords).toHaveBeenCalledWith({
      scope: collectionScope("sync_state"),
      limit: 50,
    });
  });

  it("stops at the batch ceiling rather than sweeping without bound", async () => {
    const repository = buildRepositoryStub();
    repository.listCollectionsWithExpiredRecords = vi.fn(async (limit: number) =>
      Array.from({ length: limit }, (_unused, offset) => collectionScope(`c${offset}`)),
    );
    repository.reclaimExpiredRecords = vi.fn(async () => 50);

    const sweeper = createAppStorageSweeper({
      repository,
      audit: buildAudit(),
      batchSize: 50,
      maxBatches: 3,
    });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 150, batchCount: 3 });
  });

  it("does nothing when no collection holds an expired row", async () => {
    const repository = buildRepositoryStub();
    const sweeper = createAppStorageSweeper({ repository, audit: buildAudit() });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 0, batchCount: 0 });
    expect(repository.reclaimExpiredRecords).not.toHaveBeenCalled();
  });
});

describe("app storage retention sweep", () => {
  const due: AppStorageInstallationScope[] = [
    { workspaceId, installationId },
    { workspaceId, installationId: randomUUID() },
  ];

  it("reclaims every installation whose deadline has passed and audits what it removed", async () => {
    const repository = buildRepositoryStub();
    const audit = buildAudit();
    repository.listInstallationsDueForRetention = vi.fn(async () => due);
    repository.deleteInstallationRecords = vi.fn(async () => ({
      admitted: true as const,
      value: { recordCount: 3, collectionCount: 1 },
    }));

    const result = await createAppStorageSweeper({ repository, audit }).runRetentionSweep();

    expect(result).toEqual({ installationCount: 2, recordCount: 6 });
    expect(audit.record.mock.calls.map(([event]) => event.eventType)).toEqual([
      "app.data.deletion.completed",
      "app.data.deletion.completed",
    ]);
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      eventStatus: "success",
      metadata: { reason: "retention_elapsed", recordCount: 3, collectionCount: 1 },
    });
  });

  it("counts nothing for an installation the tombstone already covers", async () => {
    const repository = buildRepositoryStub();
    const audit = buildAudit();
    repository.listInstallationsDueForRetention = vi.fn(async () => due.slice(0, 1));
    repository.deleteInstallationRecords = vi.fn(async () => ({ admitted: false as const }));

    await expect(
      createAppStorageSweeper({ repository, audit }).runRetentionSweep(),
    ).resolves.toEqual({ installationCount: 0, recordCount: 0 });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("audits a reclamation that failed and keeps working through the rest", async () => {
    const repository = buildRepositoryStub();
    const audit = buildAudit();
    repository.listInstallationsDueForRetention = vi.fn(async () => due);
    let call = 0;
    repository.deleteInstallationRecords = vi.fn(async () => {
      call += 1;
      if (call === 1) throw statementFailure();
      return { admitted: true as const, value: { recordCount: 2, collectionCount: 1 } };
    });

    const result = await createAppStorageSweeper({ repository, audit }).runRetentionSweep();

    expect(result).toEqual({ installationCount: 1, recordCount: 2 });
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ eventStatus: "failure" });
    expect(JSON.stringify(audit.record.mock.calls[0]?.[0])).not.toContain("customer-secret");
  });
});
