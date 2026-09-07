import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAppStorageDisposition,
  createAppStorageExpirySweeper,
  type AppStorageAuditPort,
  type AppStorageRepositoryPort,
  type StoredAppStorageRecord,
} from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();

const record = (collectionId: string, key: string): StoredAppStorageRecord & { collectionId: string } => ({
  collectionId,
  key,
  version: 2,
  schemaVersion: 1,
  updatedAt: new Date("2026-09-07T09:00:00.000Z"),
  value: { external_id: key },
});

const buildRepository = (): AppStorageRepositoryPort => ({
  findInstallationState: vi.fn(async () => null),
  setAccessRevoked: vi.fn(async () => undefined),
  setRetention: vi.fn(async () => undefined),
  findRecord: vi.fn(async () => null),
  putRecord: vi.fn(async () => ({ outcome: "stored" as const, version: 1 })),
  deleteRecord: vi.fn(async () => ({ outcome: "deleted" as const })),
  queryByIndex: vi.fn(async () => []),
  readCollectionUsage: vi.fn(async () => ({ recordCount: 0, byteSize: 0 })),
  deleteExpiredRecords: vi.fn(async () => 0),
  streamInstallationRecords: vi.fn(() =>
    (async function* () {
      yield record("sync_state", "post-1");
      yield record("cursors", "cursor-1");
    })(),
  ),
  deleteInstallationRecords: vi.fn(async () => ({ recordCount: 4, collectionCount: 2 })),
  deleteWorkspaceRecords: vi.fn(async () => ({ recordCount: 9, installationCount: 3 })),
});

describe("app storage disposition", () => {
  let repository: AppStorageRepositoryPort;
  let audit: AppStorageAuditPort & { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repository = buildRepository();
    audit = { record: vi.fn(async () => undefined) };
  });

  const disposition = () =>
    createAppStorageDisposition({
      repository,
      audit,
      now: () => new Date("2026-09-07T10:00:00.000Z"),
    });

  it("revokes storage access without removing a record", async () => {
    await disposition().revokeAccess({ workspaceId, installationId });
    expect(repository.setAccessRevoked).toHaveBeenCalledWith(
      { workspaceId, installationId },
      new Date("2026-09-07T10:00:00.000Z"),
    );
    expect(repository.deleteInstallationRecords).not.toHaveBeenCalled();
  });

  it("restores storage access by clearing the revocation", async () => {
    await disposition().restoreAccess({ workspaceId, installationId });
    expect(repository.setAccessRevoked).toHaveBeenCalledWith({ workspaceId, installationId }, null);
  });

  it("exports one JSON line per record, grouped by collection", async () => {
    const lines: { collectionId: string; line: string }[] = [];
    for await (const line of disposition().exportRecords({ workspaceId, installationId })) {
      lines.push(line);
    }

    expect(lines.map((line) => line.collectionId)).toEqual(["sync_state", "cursors"]);
    expect(JSON.parse(lines[0]?.line ?? "{}")).toEqual({
      collection: "sync_state",
      key: "post-1",
      version: 2,
      schemaVersion: 1,
      updatedAt: "2026-09-07T09:00:00.000Z",
      record: { external_id: "post-1" },
    });
  });

  it("audits an export as requested and then completed, carrying counts rather than data", async () => {
    for await (const _line of disposition().exportRecords({ workspaceId, installationId })) {
      // drain
    }

    expect(audit.record.mock.calls.map(([event]) => event.eventType)).toEqual([
      "app.data.export.requested",
      "app.data.export.completed",
    ]);
    const [, completed] = audit.record.mock.calls;
    expect(completed?.[0]).toMatchObject({
      workspaceId,
      installationId,
      metadata: { recordCount: 2, collectionCount: 2 },
    });
    expect(JSON.stringify(completed?.[0])).not.toContain("post-1");
  });

  it("records a bounded retention deadline", async () => {
    const until = new Date("2026-10-07T10:00:00.000Z");
    await disposition().retain({ workspaceId, installationId, until });

    expect(repository.setRetention).toHaveBeenCalledWith({ workspaceId, installationId }, until);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "app.data.retention.changed",
        metadata: expect.objectContaining({ retainUntil: until.toISOString() }),
      }),
    );
  });

  it("deletes an installation's records and audits the request and the result", async () => {
    const result = await disposition().deleteInstallationStorage({ workspaceId, installationId });

    expect(result).toEqual({ recordCount: 4, collectionCount: 2 });
    expect(audit.record.mock.calls.map(([event]) => event.eventType)).toEqual([
      "app.data.deletion.requested",
      "app.data.deletion.completed",
    ]);
  });

  it("deletes every installation's records when a workspace is deleted", async () => {
    const result = await disposition().deleteWorkspaceStorage({ workspaceId });

    expect(result).toEqual({ recordCount: 9, installationCount: 3 });
    expect(repository.deleteWorkspaceRecords).toHaveBeenCalledWith(workspaceId);
    expect(audit.record.mock.calls.map(([event]) => event.eventType)).toEqual([
      "app.data.deletion.requested",
      "app.data.deletion.completed",
    ]);
  });
});

describe("app storage expiry sweeper", () => {
  it("deletes expired records in bounded batches and stops when a batch is short", async () => {
    const repository = buildRepository();
    const sizes = [50, 50, 7];
    repository.deleteExpiredRecords = vi.fn(async () => sizes.shift() ?? 0);

    const sweeper = createAppStorageExpirySweeper({
      repository,
      now: () => new Date("2026-09-07T10:00:00.000Z"),
      batchSize: 50,
      maxBatches: 10,
    });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 107, batchCount: 3 });
  });

  it("stops at the batch ceiling rather than sweeping without bound", async () => {
    const repository = buildRepository();
    repository.deleteExpiredRecords = vi.fn(async () => 50);

    const sweeper = createAppStorageExpirySweeper({
      repository,
      now: () => new Date("2026-09-07T10:00:00.000Z"),
      batchSize: 50,
      maxBatches: 3,
    });

    await expect(sweeper.runExpirySweep()).resolves.toEqual({ deletedCount: 150, batchCount: 3 });
  });
});
