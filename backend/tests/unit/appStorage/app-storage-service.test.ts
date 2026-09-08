import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { buildRepositoryStub, connectionFailure, statementFailure } from "./repositoryStub.js";
import {
  createAppStorageCompatibilityFacts,
  createAppStorageService,
  INDEXED_STRING_CHARACTER_BOUND,
  type AppStorageRepositoryPort,
} from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();
const collection = buildStorageCollection();

describe("app storage service", () => {
  let repository: AppStorageRepositoryPort;

  beforeEach(() => {
    repository = buildRepositoryStub();
  });

  const service = () => createAppStorageService({ repository });

  const scope = { workspaceId, installationId, collection };

  it("stores a valid record and returns the version the repository assigned", async () => {
    const result = await service().put({
      ...scope,
      request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
    });
    expect(result).toEqual({ ok: true, value: { version: 1 } });
  });

  it("refuses every operation the repository did not admit, including usage", async () => {
    // Revocation and deletion are decided inside the operation's own transaction,
    // so what the service sees is an operation that was refused at the point it
    // would have taken effect rather than a state it read beforehand.
    const notAdmitted = { admitted: false as const };
    repository.findRecord = vi.fn(async () => notAdmitted);
    repository.putRecord = vi.fn(async () => notAdmitted);
    repository.deleteRecord = vi.fn(async () => notAdmitted);
    repository.queryByIndex = vi.fn(async () => notAdmitted);
    repository.readCollectionUsage = vi.fn(async () => notAdmitted);

    const denied = { ok: false, error: { code: "denied", message: expect.any(String) } };
    await expect(service().get({ ...scope, request: { collection: "sync_state", key: "post-1" } })).resolves.toMatchObject(denied);
    await expect(
      service().put({ ...scope, request: { collection: "sync_state", key: "post-1", record: { external_id: "a" } } }),
    ).resolves.toMatchObject(denied);
    await expect(service().delete({ ...scope, request: { collection: "sync_state", key: "post-1" } })).resolves.toMatchObject(denied);
    await expect(
      service().query({ ...scope, request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 10 } }),
    ).resolves.toMatchObject(denied);
    await expect(service().usage({ workspaceId, installationId, collection })).resolves.toMatchObject(denied);
  });

  it("reports a collection whose version counter is exhausted without blaming the caller", async () => {
    // A version crosses the wire as a JSON number and comes back as an
    // expectedVersion. Past the last exactly representable one, two writes would
    // share a fence, so the collection stops writing instead.
    repository.putRecord = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "version_exhausted" as const },
    }));

    const result = await service().put({
      ...scope,
      request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    // The message names no key and no stored value; it is the same sentence for
    // every caller that meets the ceiling.
    expect(result.ok === false && result.error.message).not.toContain("post-1");
  });

  it("reports whether a usage read left expired rows behind for the sweep", async () => {
    // The reclaim a usage read performs is bounded, so a backlog larger than one
    // call can take leaves the counters ahead of the rows. An operator reading a
    // number that is quietly high has no way to tell.
    repository.readCollectionUsage = vi.fn(async () => ({
      admitted: true as const,
      value: { recordCount: 40, byteSize: 900, reclaimPending: true },
    }));

    await expect(service().usage({ workspaceId, installationId, collection })).resolves.toEqual({
      ok: true,
      value: { recordCount: 40, byteSize: 900, reclaimPending: true },
    });
  });

  it("puts usage through the same admission every record operation goes through", async () => {
    await service().usage({ workspaceId, installationId, collection });
    expect(repository.readCollectionUsage).toHaveBeenCalledWith({
      workspaceId,
      installationId,
      collectionId: "sync_state",
    });
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

  it("refuses an indexed string longer than a query can ask for", async () => {
    const result = await service().put({
      ...scope,
      request: {
        collection: "sync_state",
        key: "post-1",
        record: { external_id: "x".repeat(INDEXED_STRING_CHARACTER_BOUND + 1) },
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(repository.putRecord).not.toHaveBeenCalled();
  });

  it("reports a full collection as quota_exceeded and a stale version as version_conflict", async () => {
    repository.putRecord = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "quota_exceeded" as const },
    }));
    await expect(
      service().put({ ...scope, request: { collection: "sync_state", key: "post-1", record: { external_id: "a" } } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "quota_exceeded" } });

    repository.putRecord = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "version_conflict" as const },
    }));
    await expect(
      service().put({
        ...scope,
        request: { collection: "sync_state", key: "post-1", record: { external_id: "a" }, expectedVersion: 4 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "version_conflict" } });

    repository.putRecord = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "not_found" as const },
    }));
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

  it("hands the write a ttl interval rather than a deadline it computed itself", async () => {
    const ttl = buildStorageCollection({ retention: { kind: "ttl", seconds: 3600 } });
    await service().put({
      workspaceId,
      installationId,
      collection: ttl,
      request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
    });

    // A deadline read here would be read before the write queues for a lock; the
    // interval lets the transaction that stores the row settle it from its own clock.
    expect(repository.putRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlSeconds: 3600,
        schemaVersion: 1,
        indexEntries: [
          { indexId: "by_external_id", textValue: "post-1", numericValue: null, booleanValue: null, timestampValue: null },
        ],
      }),
    );
  });

  it("reports a delete of an absent key as nothing deleted, and a fenced delete of one as not_found", async () => {
    repository.deleteRecord = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "missing" as const },
    }));
    await expect(
      service().delete({ ...scope, request: { collection: "sync_state", key: "absent" } }),
    ).resolves.toEqual({ ok: true, value: { deleted: false } });

    repository.deleteRecord = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "not_found" as const },
    }));
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
    repository.queryByIndex = vi.fn(async () => ({
      admitted: true as const,
      value: [row("post-1"), row("post-2")],
    }));
    const page = await service().query({
      ...scope,
      request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 1 },
    });
    expect(repository.queryByIndex).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(page).toMatchObject({ ok: true, value: { cursor: "post-1" } });
    if (!page.ok) return;
    expect(page.value.records.map((record) => record.key)).toEqual(["post-1"]);

    repository.queryByIndex = vi.fn(async () => ({ admitted: true as const, value: [row("post-1")] }));
    const last = await service().query({
      ...scope,
      request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 2 },
    });
    expect(last).toMatchObject({ ok: true, value: { cursor: undefined } });
  });
});

describe("app storage service failure classification", () => {
  const scope = { workspaceId, installationId, collection };

  it("turns a database that cannot be reached into unavailable rather than a rejected promise", async () => {
    const repository = buildRepositoryStub();
    repository.putRecord = vi.fn(async () => {
      throw connectionFailure();
    });

    await expect(
      createAppStorageService({ repository }).put({
        ...scope,
        request: { collection: "sync_state", key: "post-1", record: { external_id: "post-1" } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("turns any other database failure into internal and carries none of it into the message", async () => {
    const repository = buildRepositoryStub();
    repository.findRecord = vi.fn(async () => {
      throw statementFailure();
    });

    const result = await createAppStorageService({ repository }).get({
      ...scope,
      request: { collection: "sync_state", key: "post-1" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    if (result.ok) return;
    expect(result.error.message).not.toContain("customer-secret");
    expect(result.error.message).not.toContain("post-1");
    expect(result.error.message).not.toContain("value");
  });

  it("classifies every operation, so nothing in the port rejects", async () => {
    const repository = buildRepositoryStub();
    const raise = async (): Promise<never> => {
      throw connectionFailure();
    };
    repository.findRecord = vi.fn(raise);
    repository.putRecord = vi.fn(raise);
    repository.deleteRecord = vi.fn(raise);
    repository.queryByIndex = vi.fn(raise);
    repository.readCollectionUsage = vi.fn(raise);
    const service = createAppStorageService({ repository });

    const results = await Promise.all([
      service.get({ ...scope, request: { collection: "sync_state", key: "post-1" } }),
      service.put({ ...scope, request: { collection: "sync_state", key: "post-1", record: { external_id: "a" } } }),
      service.delete({ ...scope, request: { collection: "sync_state", key: "post-1" } }),
      service.query({ ...scope, request: { collection: "sync_state", index: "by_external_id", equals: "a", limit: 5 } }),
      service.usage({ workspaceId, installationId, collection }),
    ]);

    expect(results.map((result) => (result.ok ? "ok" : result.error.code))).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });
});

/**
 * The one storage fact release admission needs, and the reason it is not on the
 * capability service: what an App may call and what a release admission may
 * learn about storage history are two surfaces, and only the first is exposed
 * through the App gateway.
 */
describe("app storage compatibility facts", () => {
  it("answers the schema versions stored rows carry, so nothing outside storage reads its tables", async () => {
    const repository = buildRepositoryStub();
    repository.listStoredSchemaVersions = vi.fn(async () => ({
      admitted: true as const,
      value: [1, 3],
    }));

    const collectionScope = { workspaceId, installationId, collectionId: "sync_state" };
    await expect(
      createAppStorageCompatibilityFacts({ repository }).storedSchemaVersions(collectionScope),
    ).resolves.toEqual({ ok: true, value: [1, 3] });
    expect(repository.listStoredSchemaVersions).toHaveBeenCalledWith(collectionScope);
  });

  it("refuses against an installation the tombstone covers", async () => {
    const repository = buildRepositoryStub();
    repository.listStoredSchemaVersions = vi.fn(async () => ({ admitted: false as const }));

    await expect(
      createAppStorageCompatibilityFacts({ repository }).storedSchemaVersions({
        workspaceId,
        installationId,
        collectionId: "sync_state",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "denied" } });
  });

  it("turns a database failure into a typed result rather than a rejected promise", async () => {
    const repository = buildRepositoryStub();
    repository.listStoredSchemaVersions = vi.fn(async () => {
      throw statementFailure();
    });

    const result = await createAppStorageCompatibilityFacts({ repository }).storedSchemaVersions({
      workspaceId,
      installationId,
      collectionId: "sync_state",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(result)).not.toContain("customer-secret");
  });
});
