import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { Database } from "../../src/shared/infra/database.js";

// Real-Postgres characterization of AccountMembershipRepository. The risky behaviour is the
// create upsert on (account_id, user_id) DO UPDATE SET role = account_memberships.role,
// which must return the EXISTING row unchanged on conflict, plus the active-only filters,
// the users JOIN, and ASC ordering.

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

describeIfDatabase("AccountMembershipRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AccountMembershipRepository(database.kysely);

  const accountId = randomUUID();
  const userAId = randomUUID();
  const userBId = randomUUID();
  const userAEmail = `mem-a-${userAId}@example.com`;
  const userBEmail = `mem-b-${userBId}@example.com`;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Membership Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      userAId,
      userAEmail,
      "hash",
    ]);
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      userBId,
      userBEmail,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userAId, userBId]]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("create inserts a membership", async () => {
    const membership = await repository.create({ accountId, userId: userAId, role: "owner" });

    expect(membership.accountId).toBe(accountId);
    expect(membership.userId).toBe(userAId);
    expect(membership.role).toBe("owner");
    expect(membership.status).toBe("active");
    expect(membership.createdAt).toBeInstanceOf(Date);
  });

  it("create upserts on (account_id, user_id): returns the existing row, role unchanged", async () => {
    const first = await repository.findActiveByAccountAndUser(accountId, userAId);
    expect(first).not.toBeNull();

    const resaved = await repository.create({ accountId, userId: userAId, role: "member" });

    expect(resaved.id).toBe(first!.id);
    expect(resaved.role).toBe("owner");
  });

  it("findActiveByAccountAndUser returns null for an unknown pair", async () => {
    expect(await repository.findActiveByAccountAndUser(accountId, randomUUID())).toBeNull();
  });

  it("findById returns the membership and null when missing", async () => {
    const first = await repository.findActiveByAccountAndUser(accountId, userAId);
    const byId = await repository.findById(first!.id);
    expect(byId?.id).toBe(first!.id);

    expect(await repository.findById(randomUUID())).toBeNull();
  });

  it("listActiveByAccount joins the user email and orders by created_at ASC", async () => {
    await repository.create({ accountId, userId: userBId, role: "member" });

    const rows = await repository.listActiveByAccount(accountId);
    expect(rows.map((r) => r.userId)).toEqual([userAId, userBId]);
    const a = rows.find((r) => r.userId === userAId);
    expect(a?.email).toBe(userAEmail);
  });

  it("listActiveByUser returns active memberships for a user", async () => {
    const rows = await repository.listActiveByUser(userAId);
    expect(rows.some((r) => r.accountId === accountId)).toBe(true);
  });

  it("updateRole changes the role and advances updated_at", async () => {
    const first = await repository.findActiveByAccountAndUser(accountId, userBId);
    const updated = await repository.updateRole(first!.id, "admin");
    expect(updated.role).toBe("admin");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(first!.updatedAt.getTime());
  });

  it("deleteById returns true then false", async () => {
    const first = await repository.findActiveByAccountAndUser(accountId, userBId);
    expect(await repository.deleteById(first!.id)).toBe(true);
    expect(await repository.deleteById(first!.id)).toBe(false);
  });
});
