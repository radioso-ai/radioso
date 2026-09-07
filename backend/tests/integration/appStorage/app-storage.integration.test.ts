import { randomUUID } from "node:crypto";

import type { BoundedJsonRecord } from "@radioso/app-contract";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { createAppStorageAuditSink } from "../../../src/app/composition/appStorage.js";
import {
  AppStorageRepository,
  createAppStorageDisposition,
  createAppStorageExpirySweeper,
  createAppStorageService,
} from "../../../src/modules/appStorage/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Managed App Storage against real Postgres. The unit suite proves the rules; what
// only a database can show is that the rules hold under the primary key that carries
// them — isolation, the quota counter, the version fence, and the expiry predicate.
describeIntegration("Managed App Storage (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AppStorageRepository(database.kysely);
  const service = createAppStorageService({ repository });

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const installationId = randomUUID();
  const otherInstallationId = randomUUID();
  const collection = buildStorageCollection();

  const scope = { workspaceId, installationId, collection };
  const otherScope = { workspaceId, installationId: otherInstallationId, collection };

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`, [
      accountId,
      "App Storage Test Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "App Storage Workspace", `route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const put = (
    target: typeof scope,
    key: string,
    record: BoundedJsonRecord,
    expectedVersion?: number,
  ) =>
    service.put({
      ...target,
      request: {
        collection: collection.id,
        key,
        record,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
    });

  it("round-trips a record and versions each write", async () => {
    const first = await put(scope, "round_trip", { external_id: "a", sequence: 1 });
    expect(first).toEqual({ ok: true, value: { version: 1 } });

    const second = await put(scope, "round_trip", { external_id: "a", sequence: 2 });
    expect(second).toEqual({ ok: true, value: { version: 2 } });

    const read = await service.get({ ...scope, request: { collection: collection.id, key: "round_trip" } });
    expect(read).toMatchObject({
      ok: true,
      value: { record: { key: "round_trip", version: 2, record: { external_id: "a", sequence: 2 } } },
    });
  });

  it("hides another installation's record even when the collection and key match", async () => {
    await put(scope, "shared_key", { external_id: "mine" });
    await put(otherScope, "shared_key", { external_id: "theirs" });

    const mine = await service.get({ ...scope, request: { collection: collection.id, key: "shared_key" } });
    expect(mine).toMatchObject({ ok: true, value: { record: { record: { external_id: "mine" } } } });

    const third = { workspaceId, installationId: randomUUID(), collection };
    const stranger = await service.get({ ...third, request: { collection: collection.id, key: "shared_key" } });
    expect(stranger).toEqual({ ok: true, value: { record: null } });

    // A fenced write from an installation that holds no such record is not_found,
    // never a write into the record another installation holds under that key.
    expect(await put(third, "shared_key", { external_id: "stranger" }, 1)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    const untouched = await service.get({ ...scope, request: { collection: collection.id, key: "shared_key" } });
    expect(untouched).toMatchObject({ ok: true, value: { record: { record: { external_id: "mine" } } } });
  });

  it("fences a stale expectedVersion and leaves the stored record unchanged", async () => {
    await put(scope, "fenced", { external_id: "v1" });
    expect(await put(scope, "fenced", { external_id: "v2" }, 1)).toEqual({ ok: true, value: { version: 2 } });
    expect(await put(scope, "fenced", { external_id: "v3" }, 1)).toMatchObject({
      ok: false,
      error: { code: "version_conflict" },
    });

    const read = await service.get({ ...scope, request: { collection: collection.id, key: "fenced" } });
    expect(read).toMatchObject({ ok: true, value: { record: { version: 2, record: { external_id: "v2" } } } });
  });

  it("refuses a write past the collection's record quota and keeps the counter exact", async () => {
    const installation = randomUUID();
    const tiny = buildStorageCollection({ id: "tiny", quotas: { maxRecords: 2, maxRecordBytes: 4096 } });
    const tinyScope = { workspaceId, installationId: installation, collection: tiny };

    for (const key of ["one", "two"]) {
      expect(
        await service.put({ ...tinyScope, request: { collection: "tiny", key, record: { external_id: key } } }),
      ).toMatchObject({ ok: true });
    }

    expect(
      await service.put({
        ...tinyScope,
        request: { collection: "tiny", key: "three", record: { external_id: "three" } },
      }),
    ).toMatchObject({ ok: false, error: { code: "quota_exceeded" } });

    // Rewriting a key already stored consumes no slot.
    expect(
      await service.put({ ...tinyScope, request: { collection: "tiny", key: "one", record: { external_id: "again" } } }),
    ).toMatchObject({ ok: true });

    expect(await service.usage({ workspaceId, installationId: installation, collection: tiny })).toMatchObject({
      ok: true,
      value: { recordCount: 2 },
    });

    // A delete returns the slot, so the quota is a ceiling rather than a ratchet.
    expect(
      await service.delete({ ...tinyScope, request: { collection: "tiny", key: "two" } }),
    ).toEqual({ ok: true, value: { deleted: true } });
    expect(
      await service.put({ ...tinyScope, request: { collection: "tiny", key: "three", record: { external_id: "3" } } }),
    ).toMatchObject({ ok: true });
  });

  it("queries by a declared index, in the indexed field's own type, and pages by key", async () => {
    const installation = randomUUID();
    const indexed = { workspaceId, installationId: installation, collection };

    for (const key of ["a_1", "a_2", "a_3"]) {
      await put(indexed, key, { external_id: "group_a", sequence: 1 });
    }
    await put(indexed, "b_1", { external_id: "group_b" });

    const page = await service.query({
      ...indexed,
      request: { collection: collection.id, index: "by_external_id", equals: "group_a", limit: 2 },
    });
    expect(page).toMatchObject({ ok: true, value: { cursor: "a_2" } });
    if (!page.ok) return;
    expect(page.value.records.map((record) => record.key)).toEqual(["a_1", "a_2"]);

    const rest = await service.query({
      ...indexed,
      request: { collection: collection.id, index: "by_external_id", equals: "group_a", limit: 2, cursor: "a_2" },
    });
    expect(rest).toMatchObject({ ok: true, value: { cursor: undefined } });
    if (!rest.ok) return;
    expect(rest.value.records.map((record) => record.key)).toEqual(["a_3"]);

    // An index entry follows its record: rewriting the field moves the row out of
    // the group it used to match, rather than leaving a stale entry behind.
    await put(indexed, "a_1", { external_id: "group_b" });
    const moved = await service.query({
      ...indexed,
      request: { collection: collection.id, index: "by_external_id", equals: "group_a", limit: 10 },
    });
    if (!moved.ok) return;
    expect(moved.value.records.map((record) => record.key)).toEqual(["a_2", "a_3"]);
  });

  it("hides an expired record from reads and queries before any sweep runs", async () => {
    const installation = randomUUID();
    const ttl = buildStorageCollection({ id: "ephemeral", retention: { kind: "ttl", seconds: 60 } });
    const past = new Date(Date.now() - 3_600_000);
    const ttlScope = { workspaceId, installationId: installation, collection: ttl };

    // The clock the write reads is the one that sets the deadline, so a write dated
    // an hour ago produces a record that was already past its TTL when it landed.
    const expiringService = createAppStorageService({ repository, now: () => past });
    await expiringService.put({
      ...ttlScope,
      request: { collection: "ephemeral", key: "gone", record: { external_id: "gone" } },
    });

    expect(
      await service.get({ ...ttlScope, request: { collection: "ephemeral", key: "gone" } }),
    ).toEqual({ ok: true, value: { record: null } });

    const query = await service.query({
      ...ttlScope,
      request: { collection: "ephemeral", index: "by_external_id", equals: "gone", limit: 10 },
    });
    expect(query).toMatchObject({ ok: true, value: { records: [] } });

    const swept = await createAppStorageExpirySweeper({ repository, batchSize: 100 }).runExpirySweep();
    expect(swept.deletedCount).toBeGreaterThanOrEqual(1);
    expect(
      await service.usage({ workspaceId, installationId: installation, collection: ttl }),
    ).toMatchObject({ ok: true, value: { recordCount: 0 } });
  });

  describe("disposition", () => {
    const auditEvents: { eventType: string; workspaceId: string | null }[] = [];
    const disposition = createAppStorageDisposition({
      repository,
      audit: createAppStorageAuditSink({
        async record(event) {
          auditEvents.push({ eventType: event.eventType, workspaceId: event.workspaceId ?? null });
        },
        async getLatestSuccessfulChatAnswerMetadata() {
          return null;
        },
        async updateChatAnswerSuggestions() {
          // The storage disposition writes no chat metadata.
        },
      }),
    });

    it("revokes access without deleting, and restoring brings the record back", async () => {
      const installation = randomUUID();
      const revoked = { workspaceId, installationId: installation, collection };
      await put(revoked, "kept", { external_id: "kept" });

      await disposition.revokeAccess({ workspaceId, installationId: installation });
      expect(
        await service.get({ ...revoked, request: { collection: collection.id, key: "kept" } }),
      ).toMatchObject({ ok: false, error: { code: "denied" } });
      expect(
        await put(revoked, "kept", { external_id: "changed" }),
      ).toMatchObject({ ok: false, error: { code: "denied" } });

      await disposition.restoreAccess({ workspaceId, installationId: installation });
      expect(
        await service.get({ ...revoked, request: { collection: collection.id, key: "kept" } }),
      ).toMatchObject({ ok: true, value: { record: { record: { external_id: "kept" } } } });
    });

    it("exports one JSON line per record and then deletes the installation's data", async () => {
      const installation = randomUUID();
      const exported = { workspaceId, installationId: installation, collection };
      await put(exported, "one", { external_id: "one" });
      await put(exported, "two", { external_id: "two" });

      const lines: unknown[] = [];
      for await (const line of disposition.exportRecords({ workspaceId, installationId: installation })) {
        lines.push(JSON.parse(line.line));
      }
      expect(lines).toEqual([
        expect.objectContaining({ collection: collection.id, key: "one", record: { external_id: "one" } }),
        expect.objectContaining({ collection: collection.id, key: "two", record: { external_id: "two" } }),
      ]);

      await disposition.retain({
        workspaceId,
        installationId: installation,
        until: new Date(Date.now() + 86_400_000),
      });

      const summary = await disposition.deleteInstallationStorage({ workspaceId, installationId: installation });
      expect(summary).toEqual({ recordCount: 2, collectionCount: 1 });
      expect(
        await service.get({ ...exported, request: { collection: collection.id, key: "one" } }),
      ).toEqual({ ok: true, value: { record: null } });

      expect(auditEvents.map((event) => event.eventType)).toContain("app.data.export.completed");
      expect(auditEvents.map((event) => event.eventType)).toContain("app.data.retention.changed");
      expect(auditEvents.map((event) => event.eventType)).toContain("app.data.deletion.completed");
    });

    it("removes every installation's records when a workspace's storage is deleted", async () => {
      const disposable = randomUUID();
      await database.query(
        `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
        [disposable, accountId, "Disposable", `route-${disposable}`],
      );
      const first = randomUUID();
      const second = randomUUID();
      await put({ workspaceId: disposable, installationId: first, collection }, "x", { external_id: "x" });
      await put({ workspaceId: disposable, installationId: second, collection }, "y", { external_id: "y" });

      expect(await disposition.deleteWorkspaceStorage({ workspaceId: disposable })).toEqual({
        recordCount: 2,
        installationCount: 2,
      });
    });

    it("cascades through the workspace row when the workspace itself is deleted", async () => {
      const doomed = randomUUID();
      await database.query(
        `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
        [doomed, accountId, "Doomed", `route-${doomed}`],
      );
      const installation = randomUUID();
      await put({ workspaceId: doomed, installationId: installation, collection }, "z", { external_id: "z" });

      await database.query(`DELETE FROM workspaces WHERE id = $1`, [doomed]);

      const remaining = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app_storage_records WHERE workspace_id = $1`,
        [doomed],
      );
      expect(remaining[0]?.count).toBe("0");
    });
  });
});
