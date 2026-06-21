import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DocumentSourceRepository } from "../../src/db/repositories/documentSourceRepository.js";
import { Database } from "../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

describeIfDatabase("DocumentSourceRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new DocumentSourceRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "DocSrc Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "DocSrc Workspace",
      `route-${workspaceId}`,
    ]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM document_sources WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("upsertByExternalId inserts then merges metadata on the partial-index conflict", async () => {
    const first = await repository.upsertByExternalId({
      workspaceId,
      kind: "connector",
      name: "Src",
      externalId: "ext-1",
      config: { a: 1 },
      metadata: { keep: true },
    });
    expect(first.metadata).toEqual({ keep: true });

    const second = await repository.upsertByExternalId({
      workspaceId,
      kind: "connector",
      name: "Renamed",
      externalId: "ext-1",
      config: { b: 2 },
      metadata: { added: 1 },
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Renamed");
    expect(second.config).toEqual({ b: 2 });
    expect(second.metadata).toEqual({ keep: true, added: 1 }); // jsonb || merge
  });

  it("finds by id, existing ids, and lists with document counts", async () => {
    const a = await repository.upsertByExternalId({ workspaceId, kind: "api", name: "A", externalId: "a" });
    const b = await repository.upsertByExternalId({ workspaceId, kind: "api", name: "B", externalId: "b" });

    expect((await repository.findByIdAndWorkspaceId(a.id, workspaceId))?.id).toBe(a.id);
    expect(await repository.findByIdAndWorkspaceId(a.id, randomUUID())).toBeNull();

    const existing = await repository.findExistingIdsByWorkspaceId(workspaceId, [a.id, b.id, randomUUID()]);
    expect(existing.sort()).toEqual([a.id, b.id].sort());
    expect(await repository.findExistingIdsByWorkspaceId(workspaceId, [])).toEqual([]);

    const list = await repository.listByWorkspaceIdWithDocumentCounts(workspaceId);
    expect(list).toHaveLength(2);
    expect(list.every((s) => s.documentCount === 0)).toBe(true);
  });

  it("updates sync state (coalesce), config, and deletes", async () => {
    const s = await repository.upsertByExternalId({ workspaceId, kind: "website", name: "S", externalId: "s" });

    await repository.updateSyncState({ workspaceId, sourceId: s.id, status: "ok", syncedAt: new Date("2026-06-01T00:00:00.000Z") });
    let reloaded = await repository.findByIdAndWorkspaceId(s.id, workspaceId);
    expect(reloaded?.lastSyncStatus).toBe("ok");
    expect(reloaded?.lastSyncedAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");

    // syncedAt omitted → COALESCE keeps the previous value
    await repository.updateSyncState({ workspaceId, sourceId: s.id, status: "running" });
    reloaded = await repository.findByIdAndWorkspaceId(s.id, workspaceId);
    expect(reloaded?.lastSyncStatus).toBe("running");
    expect(reloaded?.lastSyncedAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");

    const updated = await repository.updateConfigByIdAndWorkspaceId({ sourceId: s.id, workspaceId, config: { c: 3 } });
    expect(updated.config).toEqual({ c: 3 });

    expect(await repository.deleteByIdAndWorkspaceId(s.id, workspaceId)).toBe(true);
    expect(await repository.deleteByIdAndWorkspaceId(s.id, workspaceId)).toBe(false);
  });
});
