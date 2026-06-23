import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";

// Proves the foundation invariant (decisions D1/D4): the Kysely instance is built on the
// SAME pool as the raw Database, so a row written through Kysely is visible to a raw read
// after commit, and a Kysely transaction that throws rolls back. This is what lets Kysely
// and not-yet-migrated raw repositories coexist on one pool during the migration.

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

describeIfDatabase("Kysely foundation (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const createdAccountIds: string[] = [];

  const newAccount = () => {
    const id = randomUUID();
    createdAccountIds.push(id);
    return { id, name: "Kysely Foundation", email: `kysely-${id}@example.com`, password_hash: "hash" };
  };

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await database.query(`DELETE FROM accounts WHERE id = $1`, [id]).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  });

  it("a Kysely write is visible to a raw read after commit (shared pool)", async () => {
    const account = newAccount();

    await database.kysely.insertInto("accounts").values(account).execute();

    const rows = await database.query<{ id: string }>(`SELECT id FROM accounts WHERE id = $1`, [account.id]);
    expect(rows).toHaveLength(1);
  });

  it("a Kysely transaction that throws rolls back", async () => {
    const account = newAccount();

    await expect(
      database.kysely.transaction().execute(async (trx) => {
        await trx.insertInto("accounts").values(account).execute();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await database.query<{ id: string }>(`SELECT id FROM accounts WHERE id = $1`, [account.id]);
    expect(rows).toHaveLength(0);
  });

  it("a Kysely transaction that succeeds commits", async () => {
    const account = newAccount();

    await database.kysely.transaction().execute(async (trx) => {
      await trx.insertInto("accounts").values(account).execute();
    });

    const rows = await database.query<{ id: string }>(`SELECT id FROM accounts WHERE id = $1`, [account.id]);
    expect(rows).toHaveLength(1);
  });
});
