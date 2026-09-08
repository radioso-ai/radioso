import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildRepositoryStub, statementFailure } from "./repositoryStub.js";
import {
  createAppStorageSweeper,
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

/** The audit intents the pass committed, read back off the outbox the repository writes to. */
const enqueuedIntents = (repository: ReturnType<typeof buildRepositoryStub>) =>
  (repository.enqueueAuditEvent as ReturnType<typeof vi.fn>).mock.calls.map(([call]) => call.intent);

describe("app storage expiry sweep", () => {
  it("reclaims one collection at a time and stops when a round reclaims nothing", async () => {
    const repository = buildRepositoryStub();
    const claimed = [[collectionScope("sync_state"), collectionScope("cursors")], []];
    repository.claimCollectionsForExpirySweep = vi.fn(async () => claimed.shift() ?? []);
    const reclaimed = [50, 7];
    repository.reclaimExpiredRecords = vi.fn(async () => reclaimed.shift() ?? 0);

    const sweeper = createAppStorageSweeper({ repository, batchSize: 50, maxBatches: 10 });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 57, batchCount: 2 });
    // Each batch names a collection, because the reclaim takes the installation's
    // state row and then that collection's counter; a sweep spanning collections
    // would take locks in an order no write takes them in.
    expect(repository.reclaimExpiredRecords).toHaveBeenCalledWith({
      scope: collectionScope("sync_state"),
      limit: 50,
    });
  });

  it("stops at the batch ceiling rather than sweeping without bound", async () => {
    const repository = buildRepositoryStub();
    repository.claimCollectionsForExpirySweep = vi.fn(async (limit: number) =>
      Array.from({ length: limit }, (_unused, offset) => collectionScope(`c${offset}`)),
    );
    repository.reclaimExpiredRecords = vi.fn(async () => 50);

    const sweeper = createAppStorageSweeper({ repository, batchSize: 50, maxBatches: 3 });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 150, batchCount: 3 });
  });

  it("does nothing when no collection holds an expired row", async () => {
    const repository = buildRepositoryStub();
    const sweeper = createAppStorageSweeper({ repository });

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
    repository.listInstallationsDueForRetention = vi.fn(async () => due);
    repository.reclaimRetainedInstallation = vi.fn(async (input) => {
      // The audit intent is built by the caller and committed by the same
      // transaction that deletes, so the trail cannot name a deletion that
      // rolled back or omit one that did not.
      input.audit({ recordCount: 3, collectionCount: 1 });
      return { outcome: "reclaimed" as const, summary: { recordCount: 3, collectionCount: 1 } };
    });

    const result = await createAppStorageSweeper({ repository }).runRetentionSweep();

    expect(result).toEqual({ installationCount: 2, recordCount: 6 });
    const intents = (repository.reclaimRetainedInstallation as ReturnType<typeof vi.fn>).mock.calls.map(
      ([call]) => call.audit({ recordCount: 3, collectionCount: 1 }),
    );
    expect(intents[0]).toMatchObject({
      eventType: "app.data.deletion.completed",
      eventStatus: "success",
      metadata: { reason: "retention_elapsed", recordCount: 3, collectionCount: 1 },
    });
  });

  it("leaves the data alone when an operator extended the hold after the listing", async () => {
    // The listing is a decision made outside any lock. The repository rechecks the
    // deadline while holding the state row, and this pass reports the hold rather
    // than counting a deletion that did not happen.
    const repository = buildRepositoryStub();
    repository.listInstallationsDueForRetention = vi.fn(async () => due.slice(0, 1));
    repository.reclaimRetainedInstallation = vi.fn(async () => ({ outcome: "not_due" as const }));

    await expect(createAppStorageSweeper({ repository }).runRetentionSweep()).resolves.toEqual({
      installationCount: 0,
      recordCount: 0,
    });
    expect(enqueuedIntents(repository)).toEqual([]);
  });

  it("counts nothing for an installation the tombstone already covers", async () => {
    const repository = buildRepositoryStub();
    repository.listInstallationsDueForRetention = vi.fn(async () => due.slice(0, 1));
    repository.reclaimRetainedInstallation = vi.fn(async () => ({ outcome: "tombstoned" as const }));

    await expect(createAppStorageSweeper({ repository }).runRetentionSweep()).resolves.toEqual({
      installationCount: 0,
      recordCount: 0,
    });
    expect(enqueuedIntents(repository)).toEqual([]);
  });

  it("audits a reclamation that failed and keeps working through the rest", async () => {
    const repository = buildRepositoryStub();
    repository.listInstallationsDueForRetention = vi.fn(async () => due);
    let call = 0;
    repository.reclaimRetainedInstallation = vi.fn(async () => {
      call += 1;
      if (call === 1) throw statementFailure();
      return { outcome: "reclaimed" as const, summary: { recordCount: 2, collectionCount: 1 } };
    });

    const result = await createAppStorageSweeper({ repository }).runRetentionSweep();

    expect(result).toEqual({ installationCount: 1, recordCount: 2 });
    // Nothing committed, so this event has no state change to ride along with and
    // goes to the outbox on its own.
    expect(enqueuedIntents(repository)[0]).toMatchObject({
      eventType: "app.data.deletion.completed",
      eventStatus: "failure",
      metadata: { reason: "retention_elapsed" },
    });
    expect(JSON.stringify(enqueuedIntents(repository))).not.toContain("customer-secret");
  });
});
