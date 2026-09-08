import { randomUUID } from "node:crypto";

import type { BoundedJsonRecord, StorageCollection } from "@radioso/app-contract";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { createAppStorageAuditSink } from "../../../src/app/composition/appStorage.js";
import {
  AppStorageRepository,
  createAppStorageDisposition,
  createAppStorageIndexRebuilder,
  createAppStorageService,
  createAppStorageSweeper,
  INDEXED_STRING_BYTE_BOUND,
} from "../../../src/modules/appStorage/public.js";
import type { AuditEventInput, AuditService } from "../../../src/modules/audit/contracts/index.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Events are collected as the audit spine receives them, so the identity a test
// looks for is the one an operator would actually read back.
const collectAudit = (events: AuditEventInput[]): AuditService => ({
  async record(event) {
    events.push(event);
  },
  async getLatestSuccessfulChatAnswerMetadata() {
    return null;
  },
  async updateChatAnswerSuggestions() {
    // The storage disposition writes no chat metadata.
  },
});

// Managed App Storage against real Postgres. The unit suite proves the rules; what
// only a database can show is that they hold where they are actually enforced — the
// scoped predicate, the counter row every write locks, the version the counter hands
// out, the expiry predicate, and the state row that fences a disposition.
describeIntegration("Managed App Storage (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AppStorageRepository(database.kysely);
  const service = createAppStorageService({ repository });

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const collection = buildStorageCollection();

  const installation = (): { workspaceId: string; installationId: string; collection: StorageCollection } => ({
    workspaceId,
    installationId: randomUUID(),
    collection,
  });

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
    target: { workspaceId: string; installationId: string; collection: StorageCollection },
    key: string,
    record: BoundedJsonRecord,
    expectedVersion?: number,
  ) =>
    service.put({
      ...target,
      request: {
        collection: target.collection.id,
        key,
        record,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
    });

  /** Moves a stored record's deadline into the past without waiting for one. */
  const expireNow = async (target: { workspaceId: string; installationId: string }, key: string): Promise<void> => {
    await database.query(
      `UPDATE app_storage_records SET expires_at = now() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key = $3`,
      [target.workspaceId, target.installationId, key],
    );
  };

  const versionOf = (result: Awaited<ReturnType<typeof put>>): number =>
    result.ok ? result.value.version : -1;

  it("round-trips a record and gives every write a version that only moves forward", async () => {
    const scope = installation();
    const first = await put(scope, "round_trip", { external_id: "a", sequence: 1 });
    const second = await put(scope, "round_trip", { external_id: "a", sequence: 2 });

    expect(versionOf(second)).toBeGreaterThan(versionOf(first));

    const read = await service.get({ ...scope, request: { collection: collection.id, key: "round_trip" } });
    expect(read).toMatchObject({
      ok: true,
      value: { record: { key: "round_trip", version: versionOf(second), record: { external_id: "a", sequence: 2 } } },
    });
  });

  it("never reuses a version across deletion and recreation, so a stale fence cannot match again", async () => {
    const scope = installation();
    const first = versionOf(await put(scope, "aba", { external_id: "v1" }));

    expect(await service.delete({ ...scope, request: { collection: collection.id, key: "aba" } })).toEqual({
      ok: true,
      value: { deleted: true },
    });

    const recreated = versionOf(await put(scope, "aba", { external_id: "v2" }));
    expect(recreated).toBeGreaterThan(first);

    // The client that read the first version writes with it after the record was
    // deleted and written again. Under a per-record counter this would land.
    expect(await put(scope, "aba", { external_id: "clobber" }, first)).toMatchObject({
      ok: false,
      error: { code: "version_conflict" },
    });
    expect(
      await service.get({ ...scope, request: { collection: collection.id, key: "aba" } }),
    ).toMatchObject({ ok: true, value: { record: { record: { external_id: "v2" } } } });
  });

  it("never reuses a version across expiry either", async () => {
    const scope = { ...installation(), collection: buildStorageCollection({ retention: { kind: "ttl", seconds: 60 } }) };
    const first = versionOf(await put(scope, "aba_ttl", { external_id: "v1" }));
    await expireNow(scope, "aba_ttl");

    const recreated = versionOf(await put(scope, "aba_ttl", { external_id: "v2" }));
    expect(recreated).toBeGreaterThan(first);
    expect(await put(scope, "aba_ttl", { external_id: "clobber" }, first)).toMatchObject({
      ok: false,
      error: { code: "version_conflict" },
    });
  });

  it("hides another installation's record even when the collection and key match", async () => {
    const mineScope = installation();
    const theirScope = installation();
    await put(mineScope, "shared_key", { external_id: "mine" });
    await put(theirScope, "shared_key", { external_id: "theirs" });

    expect(
      await service.get({ ...mineScope, request: { collection: collection.id, key: "shared_key" } }),
    ).toMatchObject({ ok: true, value: { record: { record: { external_id: "mine" } } } });

    const third = installation();
    expect(
      await service.get({ ...third, request: { collection: collection.id, key: "shared_key" } }),
    ).toEqual({ ok: true, value: { record: null } });

    // A fenced write from an installation that holds no such record is not_found,
    // never a write into the record another installation holds under that key.
    expect(await put(third, "shared_key", { external_id: "stranger" }, 1)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      await service.get({ ...mineScope, request: { collection: collection.id, key: "shared_key" } }),
    ).toMatchObject({ ok: true, value: { record: { record: { external_id: "mine" } } } });
  });

  it("fences a stale expectedVersion and leaves the stored record unchanged", async () => {
    const scope = installation();
    const first = versionOf(await put(scope, "fenced", { external_id: "v1" }));
    const second = versionOf(await put(scope, "fenced", { external_id: "v2" }, first));
    expect(second).toBeGreaterThan(first);

    expect(await put(scope, "fenced", { external_id: "v3" }, first)).toMatchObject({
      ok: false,
      error: { code: "version_conflict" },
    });
    expect(
      await service.get({ ...scope, request: { collection: collection.id, key: "fenced" } }),
    ).toMatchObject({ ok: true, value: { record: { version: second, record: { external_id: "v2" } } } });
  });

  it("refuses a write past the collection's record quota and keeps the counter exact", async () => {
    const tiny = buildStorageCollection({ id: "tiny", quotas: { maxRecords: 2, maxRecordBytes: 4096 } });
    const scope = { ...installation(), collection: tiny };

    for (const key of ["one", "two"]) {
      expect(await put(scope, key, { external_id: key })).toMatchObject({ ok: true });
    }
    expect(await put(scope, "three", { external_id: "three" })).toMatchObject({
      ok: false,
      error: { code: "quota_exceeded" },
    });

    // Rewriting a key already stored consumes no slot.
    expect(await put(scope, "one", { external_id: "again" })).toMatchObject({ ok: true });
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 2 } });

    // A delete returns the slot, so the quota is a ceiling rather than a ratchet.
    expect(await service.delete({ ...scope, request: { collection: "tiny", key: "two" } })).toEqual({
      ok: true,
      value: { deleted: true },
    });
    expect(await put(scope, "three", { external_id: "3" })).toMatchObject({ ok: true });
  });

  it("gives an expired record's quota slot back to the very next write, with no sweep in between", async () => {
    const tiny = buildStorageCollection({
      id: "tiny_ttl",
      quotas: { maxRecords: 1, maxRecordBytes: 4096 },
      retention: { kind: "ttl", seconds: 60 },
    });
    const scope = { ...installation(), collection: tiny };

    expect(await put(scope, "first", { external_id: "first" })).toMatchObject({ ok: true });
    await expireNow(scope, "first");

    // A different key, so the write needs a slot rather than reusing one.
    expect(await put(scope, "second", { external_id: "second" })).toMatchObject({ ok: true });
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("reports usage live rather than as of the last sweep", async () => {
    const ttl = buildStorageCollection({ id: "usage_ttl", retention: { kind: "ttl", seconds: 60 } });
    const scope = { ...installation(), collection: ttl };
    await put(scope, "a", { external_id: "a" });
    await put(scope, "b", { external_id: "b" });
    await expireNow(scope, "a");

    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("queries by a declared index, in the indexed field's own type, and pages by key", async () => {
    const scope = installation();
    for (const key of ["a_1", "a_2", "a_3"]) {
      await put(scope, key, { external_id: "group_a", sequence: 1 });
    }
    await put(scope, "b_1", { external_id: "group_b" });

    const page = await service.query({
      ...scope,
      request: { collection: collection.id, index: "by_external_id", equals: "group_a", limit: 2 },
    });
    expect(page).toMatchObject({ ok: true, value: { cursor: "a_2" } });
    if (!page.ok) return;
    expect(page.value.records.map((record) => record.key)).toEqual(["a_1", "a_2"]);

    const rest = await service.query({
      ...scope,
      request: { collection: collection.id, index: "by_external_id", equals: "group_a", limit: 2, cursor: "a_2" },
    });
    expect(rest).toMatchObject({ ok: true, value: { cursor: undefined } });
    if (!rest.ok) return;
    expect(rest.value.records.map((record) => record.key)).toEqual(["a_3"]);

    // An index entry follows its record: rewriting the field moves the row out of
    // the group it used to match, rather than leaving a stale entry behind.
    await put(scope, "a_1", { external_id: "group_b" });
    const moved = await service.query({
      ...scope,
      request: { collection: collection.id, index: "by_external_id", equals: "group_a", limit: 10 },
    });
    if (!moved.ok) return;
    expect(moved.value.records.map((record) => record.key)).toEqual(["a_2", "a_3"]);
  });

  it("hides an expired record from reads and queries before any sweep runs", async () => {
    const ttl = buildStorageCollection({ id: "ephemeral", retention: { kind: "ttl", seconds: 60 } });
    const scope = { ...installation(), collection: ttl };
    await put(scope, "gone", { external_id: "gone" });
    await expireNow(scope, "gone");

    expect(await service.get({ ...scope, request: { collection: "ephemeral", key: "gone" } })).toEqual({
      ok: true,
      value: { record: null },
    });
    expect(
      await service.query({
        ...scope,
        request: { collection: "ephemeral", index: "by_external_id", equals: "gone", limit: 10 },
      }),
    ).toMatchObject({ ok: true, value: { records: [] } });
  });

  it("accepts the largest index entry the contract allows, with the longest key and identifiers", async () => {
    // The bound is derived from what a whole B-tree tuple holds, so the case that
    // proves it is the worst tuple the contract admits: an incompressible value at
    // the ceiling, the longest identifiers, and the longest record key.
    const longId = "c".repeat(64);
    const widest = buildStorageCollection({
      id: longId,
      indexes: [{ id: "i".repeat(64), field: "external_id" }],
      quotas: { maxRecords: 10, maxRecordBytes: 65_536 },
    });
    const scope = { ...installation(), collection: widest };
    // Random ASCII rather than a repeated character, so nothing compresses it out
    // of the tuple the index has to hold.
    const value = Array.from({ length: INDEXED_STRING_BYTE_BOUND }, () =>
      String.fromCharCode(33 + Math.floor(Math.random() * 94)),
    ).join("");
    const key = "k".repeat(256);

    expect(await put(scope, key, { external_id: value })).toMatchObject({ ok: true });
    expect(
      await service.query({
        ...scope,
        request: { collection: longId, index: "i".repeat(64), equals: value, limit: 10 },
      }),
    ).toMatchObject({ ok: true, value: { records: [{ key }] } });
  });

  it("claims the least recently swept collections first, so a busy one cannot starve another", async () => {
    const ttl = buildStorageCollection({ id: "fair_a", retention: { kind: "ttl", seconds: 60 } });
    const other = buildStorageCollection({ id: "fair_b", retention: { kind: "ttl", seconds: 60 } });
    const base = installation();
    for (const declared of [ttl, other]) {
      const scope = { ...base, collection: declared };
      await put(scope, "one", { external_id: "one" });
      await expireNow(scope, "one");
    }

    // `fair_b` was swept a moment ago and `fair_a` a long time ago, so a claim of
    // one names `fair_a`. Without the cursor, an unordered LIMIT could return
    // either — and keep returning the same one every pass.
    await database.query(
      `UPDATE app_storage_collection_usage
       SET last_swept_at = CASE collection_id WHEN 'fair_a' THEN to_timestamp(0) ELSE clock_timestamp() END
       WHERE workspace_id = $1 AND installation_id = $2`,
      [base.workspaceId, base.installationId],
    );

    const claimed = await repository.claimCollectionsForExpirySweep(100);
    const mine = claimed
      .filter((row) => row.installationId === base.installationId)
      .map((row) => row.collectionId);
    expect(mine).toEqual(["fair_a", "fair_b"]);

    // The claim moves the cursor on the rows it took, which is what puts them
    // behind everything else on the next pass.
    const swept = await database.query<{ collection_id: string; recent: boolean }>(
      `SELECT collection_id, last_swept_at > to_timestamp(0) AS recent
       FROM app_storage_collection_usage WHERE workspace_id = $1 AND installation_id = $2
       ORDER BY collection_id`,
      [base.workspaceId, base.installationId],
    );
    expect(swept).toEqual([
      { collection_id: "fair_a", recent: true },
      { collection_id: "fair_b", recent: true },
    ]);
  });

  it("reclaims expired rows in the sweep and leaves the counter describing what is there", async () => {
    const ttl = buildStorageCollection({ id: "swept", retention: { kind: "ttl", seconds: 60 } });
    const scope = { ...installation(), collection: ttl };
    for (const key of ["x", "y"]) await put(scope, key, { external_id: key });
    await expireNow(scope, "x");
    await expireNow(scope, "y");

    const swept = await createAppStorageSweeper({ repository, batchSize: 100 }).runExpirySweep();

    expect(swept.deletedCount).toBeGreaterThanOrEqual(2);
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 0 } });
  });

  it("makes records written before an index existed queryable once the index is rebuilt", async () => {
    const before = buildStorageCollection({ id: "rebuilt", indexes: [{ id: "by_external_id", field: "external_id" }] });
    const scope = { ...installation(), collection: before };
    for (const key of ["r1", "r2", "r3"]) {
      await put(scope, key, { external_id: "shared", sequence: 7 });
    }

    // The candidate release declares a second index. Its entries do not exist for
    // records the earlier release wrote, so the query answers nothing until the
    // rebuild has run over them.
    const after = buildStorageCollection({
      id: "rebuilt",
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
      ],
    });
    const candidateScope = { ...scope, collection: after };

    const beforeRebuild = await service.query({
      ...candidateScope,
      request: { collection: "rebuilt", index: "by_sequence", equals: 7, limit: 10 },
    });
    expect(beforeRebuild).toMatchObject({ ok: true, value: { records: [] } });

    const rebuilt = await createAppStorageIndexRebuilder({ repository, batchSize: 2 }).rebuildIndex({
      workspaceId: scope.workspaceId,
      installationId: scope.installationId,
      collection: after,
      indexId: "by_sequence",
    });
    expect(rebuilt).toMatchObject({ ok: true, value: { rebuiltCount: 3 } });

    const afterRebuild = await service.query({
      ...candidateScope,
      request: { collection: "rebuilt", index: "by_sequence", equals: 7, limit: 10 },
    });
    if (!afterRebuild.ok) return;
    expect(afterRebuild.value.records.map((record) => record.key)).toEqual(["r1", "r2", "r3"]);
  });

  describe("disposition", () => {
    const auditEvents: AuditEventInput[] = [];
    const audit = createAppStorageAuditSink(collectAudit(auditEvents));
    const disposition = createAppStorageDisposition({ repository, audit });

    const eventTypes = (): string[] => auditEvents.map((event) => event.eventType);

    it("revokes access without deleting, and restoring brings the record back", async () => {
      const scope = installation();
      await put(scope, "kept", { external_id: "kept" });

      await disposition.revokeAccess(scope);
      expect(
        await service.get({ ...scope, request: { collection: collection.id, key: "kept" } }),
      ).toMatchObject({ ok: false, error: { code: "denied" } });
      expect(await put(scope, "kept", { external_id: "changed" })).toMatchObject({
        ok: false,
        error: { code: "denied" },
      });
      // Usage goes through the same admission, so a revoked App learns nothing
      // about how much it stored either.
      expect(await service.usage(scope)).toMatchObject({ ok: false, error: { code: "denied" } });

      await disposition.restoreAccess(scope);
      expect(
        await service.get({ ...scope, request: { collection: collection.id, key: "kept" } }),
      ).toMatchObject({ ok: true, value: { record: { record: { external_id: "kept" } } } });
    });

    it("exports every collection over several batches, at one snapshot, skipping expired rows", async () => {
      const ttl = buildStorageCollection({ id: "export_ttl", retention: { kind: "ttl", seconds: 60 } });
      const scope = installation();
      for (const key of ["one", "two", "three"]) await put(scope, key, { external_id: key });
      await put({ ...scope, collection: ttl }, "kept", { external_id: "kept" });
      await put({ ...scope, collection: ttl }, "stale", { external_id: "stale" });
      await expireNow(scope, "stale");

      const batched = createAppStorageDisposition({ repository, audit, exportBatchSize: 2 });
      const admission = await batched.export(scope);
      expect(admission.ok).toBe(true);
      if (!admission.ok) return;

      const lines: { collection: string; key: string }[] = [];
      for await (const event of admission.stream) {
        expect(event.kind).toBe("line");
        if (event.kind === "line") lines.push(JSON.parse(event.line) as { collection: string; key: string });
      }
      await batched.drainAuditOutbox();

      expect(lines.map((line) => `${line.collection}/${line.key}`)).toEqual([
        "export_ttl/kept",
        "sync_state/one",
        "sync_state/three",
        "sync_state/two",
      ]);
      expect(eventTypes()).toContain("app.data.export.completed");
    });

    it("audits an export whose consumer stops early as cancelled", async () => {
      const scope = installation();
      await put(scope, "one", { external_id: "one" });
      await put(scope, "two", { external_id: "two" });

      const batched = createAppStorageDisposition({ repository, audit, exportBatchSize: 1 });
      const admission = await batched.export(scope);
      expect(admission.ok).toBe(true);
      if (!admission.ok) return;

      for await (const _event of admission.stream) {
        break;
      }
      await batched.drainAuditOutbox();

      expect(eventTypes()).toContain("app.data.export.cancelled");
    });

    it("leaves a tombstone that refuses every later operation, including a recreation", async () => {
      const scope = installation();
      await put(scope, "one", { external_id: "one" });
      await put(scope, "two", { external_id: "two" });

      expect(await disposition.deleteInstallationStorage(scope)).toEqual({
        ok: true,
        value: { recordCount: 2, collectionCount: 1 },
      });

      const denied = { ok: false, error: { code: "denied" } };
      expect(await service.get({ ...scope, request: { collection: collection.id, key: "one" } })).toMatchObject(denied);
      expect(await put(scope, "three", { external_id: "three" })).toMatchObject(denied);
      expect(await service.usage(scope)).toMatchObject(denied);
      expect(await disposition.revokeAccess(scope)).toMatchObject(denied);

      const rows = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app_storage_records WHERE installation_id = $1`,
        [scope.installationId],
      );
      expect(rows[0]?.count).toBe("0");
    });

    it("refuses a retention deadline outside policy and audits the refusal", async () => {
      const scope = installation();
      const beyond = new Date(Date.now() + 200 * 86_400_000);
      expect(await disposition.retain({ ...scope, until: beyond })).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
      // The refusal is committed to storage's own outbox, and draining is what
      // puts it on the audit spine.
      await disposition.drainAuditOutbox();
      expect(
        auditEvents.some(
          (event) => event.eventType === "app.data.retention.changed" && event.eventStatus === "failure",
        ),
      ).toBe(true);
    });

    it("deletes a retained installation once its deadline passes, and audits the counts", async () => {
      const scope = installation();
      await put(scope, "held", { external_id: "held" });
      await disposition.retain({ ...scope, until: new Date(Date.now() + 86_400_000) });

      // The deadline is the operator's, so a test moves it rather than waiting a day.
      await database.query(
        `UPDATE app_storage_installation_state SET retain_until = now() - interval '1 minute'
         WHERE workspace_id = $1 AND installation_id = $2`,
        [scope.workspaceId, scope.installationId],
      );

      const before = auditEvents.length;
      const swept = await createAppStorageSweeper({ repository }).runRetentionSweep();
      expect(swept.installationCount).toBeGreaterThanOrEqual(1);
      // The reclaim committed its audit intent with the deletion; publishing it
      // is the drain's job afterwards.
      await disposition.drainAuditOutbox();

      const completed = auditEvents
        .slice(before)
        .find(
          (event) =>
            event.eventType === "app.data.deletion.completed" &&
            event.metadata?.installationId === scope.installationId,
        );
      expect(completed).toMatchObject({
        eventType: "app.data.deletion.completed",
        eventStatus: "success",
        metadata: expect.objectContaining({ reason: "retention_elapsed", recordCount: 1 }),
      });

      // The tombstone the reclamation left outranks every later operation.
      expect(await put(scope, "held", { external_id: "again" })).toMatchObject({
        ok: false,
        error: { code: "denied" },
      });
    });

    /**
     * There is no workspace-wide storage helper. A workspace's storage goes with
     * the workspace row through the cascade every one of these tables carries, and
     * a second path removing the same rows without holding any installation's
     * fence could only race the first.
     */
    it("cascades out of all four tables when the workspace row itself is deleted", async () => {
      const doomed = randomUUID();
      await database.query(
        `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
        [doomed, accountId, "Doomed", `route-${doomed}`],
      );
      const scope = { workspaceId: doomed, installationId: randomUUID(), collection };
      await put(scope, "z", { external_id: "z" });

      const counts = async (): Promise<Record<string, string | undefined>> => {
        const rows = await database.query<{ table_name: string; count: string }>(
          `SELECT 'records' AS table_name, count(*)::text AS count FROM app_storage_records WHERE workspace_id = $1
           UNION ALL SELECT 'index_entries', count(*)::text FROM app_storage_index_entries WHERE workspace_id = $1
           UNION ALL SELECT 'usage', count(*)::text FROM app_storage_collection_usage WHERE workspace_id = $1
           UNION ALL SELECT 'state', count(*)::text FROM app_storage_installation_state WHERE workspace_id = $1`,
          [doomed],
        );
        return Object.fromEntries(rows.map((row) => [row.table_name, row.count]));
      };

      expect(await counts()).toEqual({ records: "1", index_entries: "1", usage: "1", state: "1" });
      await database.query(`DELETE FROM workspaces WHERE id = $1`, [doomed]);
      expect(await counts()).toEqual({ records: "0", index_entries: "0", usage: "0", state: "0" });
    });
  });
});
