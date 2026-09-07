import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  createAppStorageService,
  type AppStorageRepositoryPort,
} from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();
const collection = buildStorageCollection();

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
  streamInstallationRecords: vi.fn(() => (async function* () {})()),
  deleteInstallationRecords: vi.fn(async () => ({ recordCount: 0, collectionCount: 0 })),
  deleteWorkspaceRecords: vi.fn(async () => ({ recordCount: 0, installationCount: 0 })),
});

describe("app storage service", () => {
  let repository: AppStorageRepositoryPort;

  beforeEach(() => {
    repository = buildRepository();
  });

  const service = () => createAppStorageService({ repository, now: () => new Date("2026-09-07T10:00:00.000Z") });

  const scope = { workspaceId, installationId, collection };

  it("stores a valid record and returns the version the repository assigned", async () => {
    const result = await service().put({
      ...scope,
      request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
    });
    expect(result).toEqual({ ok: true, value: { version: 1 } });
  });

  it("refuses every operation once the installation's storage access is revoked", async () => {
    repository.findInstallationState = vi.fn(async () => ({
      accessRevokedAt: new Date("2026-09-01T00:00:00.000Z"),
      retainUntil: null,
    }));

    const denied = { ok: false, error: { code: "denied", message: expect.any(String) } };
    await expect(service().get({ ...scope, request: { collection: "sync_state", key: "post-1" } })).resolves.toMatchObject(denied);
    await expect(
      service().put({ ...scope, request: { collection: "sync_state", key: "post-1", record: { external_id: "a" } } }),
    ).resolves.toMatchObject(denied);
    await expect(service().delete({ ...scope, request: { collection: "sync_state", key: "post-1" } })).resolves.toMatchObject(denied);
    await expect(
      service().query({ ...scope, request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 10 } }),
    ).resolves.toMatchObject(denied);
    expect(repository.putRecord).not.toHaveBeenCalled();
  });

  it("refuses a request naming a collection other than the one declared for it", async () => {
    const result = await service().get({
      ...scope,
      request: { collection: "other_collection", key: "post-1" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(repository.findRecord).not.toHaveBeenCalled();
  });

  it("refuses an operation the collection does not allow", async () => {
    const readOnly = buildStorageCollection({ allowedOperations: ["get"] });
    const result = await service().put({
      workspaceId,
      installationId,
      collection: readOnly,
      request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(repository.putRecord).not.toHaveBeenCalled();
  });

  it("refuses an invalid record before reaching the repository", async () => {
    const result = await service().put({
      ...scope,
      request: { collection: "sync_state", key: "post-1", record: { sequence: 1 } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(repository.putRecord).not.toHaveBeenCalled();
  });

  it("reports a full collection as quota_exceeded and a stale version as version_conflict", async () => {
    repository.putRecord = vi.fn(async () => ({ outcome: "quota_exceeded" as const }));
    await expect(
      service().put({ ...scope, request: { collection: "sync_state", key: "post-1", record: { external_id: "a" } } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "quota_exceeded" } });

    repository.putRecord = vi.fn(async () => ({ outcome: "version_conflict" as const }));
    await expect(
      service().put({
        ...scope,
        request: { collection: "sync_state", key: "post-1", record: { external_id: "a" }, expectedVersion: 4 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "version_conflict" } });

    repository.putRecord = vi.fn(async () => ({ outcome: "not_found" as const }));
    await expect(
      service().put({
        ...scope,
        request: { collection: "sync_state", key: "post-1", record: { external_id: "a" }, expectedVersion: 4 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("answers a read for a key it holds no record for with a null record", async () => {
    const result = await service().get({ ...scope, request: { collection: "sync_state", key: "absent" } });
    expect(result).toEqual({ ok: true, value: { record: null } });
  });

  it("passes the ttl deadline and the declared index entries down to the write", async () => {
    const ttl = buildStorageCollection({ retention: { kind: "ttl", seconds: 3600 } });
    await service().put({
      workspaceId,
      installationId,
      collection: ttl,
      request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
    });

    expect(repository.putRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date("2026-09-07T11:00:00.000Z"),
        schemaVersion: 1,
        indexEntries: [
          { indexId: "by_external_id", textValue: "post-1", numericValue: null, booleanValue: null, timestampValue: null },
        ],
      }),
    );
  });

  it("reports a delete of an absent key as nothing deleted, and a fenced delete of one as not_found", async () => {
    repository.deleteRecord = vi.fn(async () => ({ outcome: "missing" as const }));
    await expect(
      service().delete({ ...scope, request: { collection: "sync_state", key: "absent" } }),
    ).resolves.toEqual({ ok: true, value: { deleted: false } });

    repository.deleteRecord = vi.fn(async () => ({ outcome: "not_found" as const }));
    await expect(
      service().delete({ ...scope, request: { collection: "sync_state", key: "absent", expectedVersion: 2 } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("returns a cursor only while the index holds another page", async () => {
    const row = (key: string) => ({
      key,
      version: 1,
      schemaVersion: 1,
      updatedAt: new Date("2026-09-07T09:00:00.000Z"),
      value: { external_id: "a" },
    });

    // The page reads one past its limit, so "is there another page" is answered
    // by the read itself rather than by a second count over the same index.
    repository.queryByIndex = vi.fn(async () => [row("post-1"), row("post-2")]);
    const page = await service().query({
      ...scope,
      request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 1 },
    });
    expect(repository.queryByIndex).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(page).toMatchObject({ ok: true, value: { cursor: "post-1" } });
    if (!page.ok) return;
    expect(page.value.records.map((record) => record.key)).toEqual(["post-1"]);

    repository.queryByIndex = vi.fn(async () => [row("post-1")]);
    const last = await service().query({
      ...scope,
      request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 2 },
    });
    expect(last).toMatchObject({ ok: true, value: { cursor: undefined } });
  });
});
