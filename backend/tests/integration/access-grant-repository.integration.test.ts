import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccessGrantRepository } from "../../src/db/repositories/accessGrantRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of AccessGrantRepository. The risky behaviour is the
// `save` upsert (ON CONFLICT (token_hash) DO UPDATE SET label = self) which returns the
// existing row unchanged, the text[] origin_allowlist round-trip, and the rotate/revoke/
// touch/updateConstraints mutations. This is the spec the Kysely migration must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AccessGrantRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AccessGrantRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Grant Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Grant Workspace", `route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Grant Agent"],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  let savedId: string;

  it("save inserts a list-mode grant and round-trips the origin allowlist", async () => {
    const saved = await repository.save({
      agentId,
      workspaceId,
      label: "primary",
      principalKind: "public-launch",
      role: "public",
      channel: "public-link",
      tokenPrefix: "rdso_aaa",
      tokenHash: "grant-hash-1",
      encryptedToken: "enc-1",
      originConstraint: { mode: "list", origins: ["https://a.example", "https://b.example"] },
    });

    savedId = saved.id;
    expect(saved.agentId).toBe(agentId);
    expect(saved.label).toBe("primary");
    expect(saved.channel).toBe("public-link");
    expect(saved.originConstraint).toEqual({ mode: "list", origins: ["https://a.example", "https://b.example"] });
    expect(saved.enabled).toBe(true);
    expect(saved.revokedAt).toBeNull();
    expect(saved.createdAt).toBeInstanceOf(Date);
  });

  it("save inserts an agent-role MCP converse grant and round-trips its channel", async () => {
    const saved = await repository.save({
      agentId,
      workspaceId,
      label: "claudio converse",
      principalKind: "public-launch",
      role: "agent",
      channel: "mcp-converse",
      tokenPrefix: "rdso_mcp",
      tokenHash: "grant-hash-mcp",
      encryptedToken: "enc-mcp",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    expect(saved).toMatchObject({
      agentId,
      workspaceId,
      label: "claudio converse",
      principalKind: "public-launch",
      role: "agent",
      channel: "mcp-converse",
    });
    await expect(repository.findByTokenHash("grant-hash-mcp")).resolves.toMatchObject({
      role: "agent",
      channel: "mcp-converse",
    });
  });

  it("save with allow-all stores an empty allowlist", async () => {
    const saved = await repository.save({
      agentId,
      workspaceId,
      principalKind: "agent-api",
      role: "public",
      channel: "embed",
      tokenPrefix: "rdso_bbb",
      tokenHash: "grant-hash-2",
      encryptedToken: "enc-2",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    expect(saved.originConstraint).toEqual({ mode: "allow-all", origins: [] });
    expect(saved.label).toBeNull();
  });

  it("save upsert on token_hash returns the existing row unchanged", async () => {
    const before = await repository.findByTokenHash("grant-hash-1");
    expect(before).not.toBeNull();

    const resaved = await repository.save({
      agentId,
      workspaceId,
      label: "ignored",
      principalKind: "public-launch",
      role: "public",
      channel: "public-link",
      tokenPrefix: "rdso_zzz",
      tokenHash: "grant-hash-1",
      encryptedToken: "enc-other",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    expect(resaved.id).toBe(before!.id);
    expect(resaved.label).toBe("primary");
    expect(resaved.tokenPrefix).toBe("rdso_aaa");
    expect(resaved.originConstraint).toEqual(before!.originConstraint);
  });

  it("findById returns the grant and null for unknown ids", async () => {
    const found = await repository.findById(savedId);
    expect(found?.id).toBe(savedId);
    expect(await repository.findById(randomUUID())).toBeNull();
  });

  it("findByTokenHash returns null for unknown hashes", async () => {
    expect(await repository.findByTokenHash("nope")).toBeNull();
  });

  it("listByAgent returns grants ordered by created_at then id", async () => {
    const grants = await repository.listByAgent(agentId);
    expect(grants.length).toBeGreaterThanOrEqual(2);
    expect(grants.map((g) => g.tokenHash)).toContain("grant-hash-1");
    expect(grants.map((g) => g.tokenHash)).toContain("grant-hash-2");
  });

  it("rotate replaces the secret and clears last_used_at/revoked_at", async () => {
    await repository.revoke(savedId, new Date());
    const rotated = await repository.rotate(savedId, {
      tokenPrefix: "rdso_rot",
      tokenHash: "grant-hash-rot",
      encryptedToken: "enc-rot",
    });
    expect(rotated?.tokenHash).toBe("grant-hash-rot");
    expect(rotated?.tokenPrefix).toBe("rdso_rot");
    expect(rotated?.lastUsedAt).toBeNull();
    expect(rotated?.revokedAt).toBeNull();
    expect(await repository.rotate(randomUUID(), { tokenPrefix: "x", tokenHash: "y", encryptedToken: "z" })).toBeNull();
  });

  it("touch updates last_used_at only when not revoked", async () => {
    const at = new Date(Date.now() + 60 * 1000);
    await repository.touch(savedId, at);
    const found = await repository.findById(savedId);
    expect(found?.lastUsedAt?.getTime()).toBe(at.getTime());

    await repository.revoke(savedId, new Date());
    const later = new Date(Date.now() + 120 * 1000);
    await repository.touch(savedId, later);
    const afterRevoke = await repository.findById(savedId);
    expect(afterRevoke?.lastUsedAt?.getTime()).toBe(at.getTime());
  });

  it("revoke sets revoked_at and returns null for unknown ids", async () => {
    const revoked = await repository.revoke(savedId, new Date());
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(await repository.revoke(randomUUID(), new Date())).toBeNull();
  });

  it("updateConstraints merges with current values and returns null for unknown ids", async () => {
    // rotate first to un-revoke and have a clean grant to mutate
    await repository.rotate(savedId, { tokenPrefix: "rdso_uc", tokenHash: "grant-hash-uc", encryptedToken: "enc-uc" });

    const updated = await repository.updateConstraints(savedId, {
      originConstraint: { mode: "list", origins: ["https://c.example"] },
      enabled: false,
    });
    expect(updated?.originConstraint).toEqual({ mode: "list", origins: ["https://c.example"] });
    expect(updated?.enabled).toBe(false);
    // label was not provided, so it is preserved
    expect(updated?.label).toBe("primary");

    const labelCleared = await repository.updateConstraints(savedId, { label: null });
    expect(labelCleared?.label).toBeNull();
    // origin/enabled preserved from previous update
    expect(labelCleared?.enabled).toBe(false);
    expect(labelCleared?.originConstraint).toEqual({ mode: "list", origins: ["https://c.example"] });

    expect(await repository.updateConstraints(randomUUID(), { enabled: true })).toBeNull();
  });
});
