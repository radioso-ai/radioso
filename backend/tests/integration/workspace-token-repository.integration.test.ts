import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspaceTokenRepository } from "../../src/db/repositories/workspaceTokenRepository.js";
import { Database } from "../../src/shared/infra/database.js";

// Real-Postgres characterization of WorkspaceTokenRepository. The risky behaviour here is
// the `save` upsert (ON CONFLICT (workspace_id) DO UPDATE ... revoked_at = NULL): it must
// preserve the row id/created_at and reset revocation. This is the spec the Kysely
// migration must preserve.

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) {
    return false;
  }
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

describeIfDatabase("WorkspaceTokenRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new WorkspaceTokenRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Token Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Token Workspace", `route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("save inserts a new token", async () => {
    const saved = await repository.save({
      workspaceId,
      accountId,
      tokenPrefix: "rdso_aaa",
      tokenHash: "hash-1",
      encryptedToken: "enc-1",
    });

    expect(saved.workspaceId).toBe(workspaceId);
    expect(saved.tokenHash).toBe("hash-1");
    expect(saved.revokedAt).toBeNull();
    expect(saved.createdAt).toBeInstanceOf(Date);
  });

  it("save upserts on workspace_id: same row, new secret, revocation reset", async () => {
    const first = await repository.findByWorkspaceId(workspaceId);
    expect(first).not.toBeNull();

    // revoke it directly, then re-save — the upsert must un-revoke and keep the same id.
    await database.query(`UPDATE workspace_tokens SET revoked_at = NOW() WHERE workspace_id = $1`, [workspaceId]);

    const resaved = await repository.save({
      workspaceId,
      accountId,
      tokenPrefix: "rdso_bbb",
      tokenHash: "hash-2",
      encryptedToken: "enc-2",
    });

    expect(resaved.id).toBe(first!.id);
    expect(resaved.createdAt.getTime()).toBe(first!.createdAt.getTime());
    expect(resaved.tokenHash).toBe("hash-2");
    expect(resaved.revokedAt).toBeNull();
  });

  it("findByTokenHash returns the active token and ignores revoked ones", async () => {
    const found = await repository.findByTokenHash("hash-2");
    expect(found?.workspaceId).toBe(workspaceId);

    await database.query(`UPDATE workspace_tokens SET revoked_at = NOW() WHERE workspace_id = $1`, [workspaceId]);
    const afterRevoke = await repository.findByTokenHash("hash-2");
    expect(afterRevoke).toBeNull();
  });

  it("touch updates last_used_at for the active token", async () => {
    // re-activate via save so there is an active token to touch
    await repository.save({ workspaceId, accountId, tokenPrefix: "rdso_ccc", tokenHash: "hash-3", encryptedToken: "enc-3" });
    const at = new Date(Date.now() + 60 * 1000);

    await repository.touch(workspaceId, at);

    const found = await repository.findByWorkspaceId(workspaceId);
    expect(found?.lastUsedAt?.getTime()).toBe(at.getTime());
  });
});
