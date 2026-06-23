import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConversationOwnershipRepository } from "../../../src/db/repositories/conversationOwnershipRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { applyTestMigration } from "../../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createClientBackedDatabase = (client: PoolClient): Database => {
  // A one-connection pool that always hands back the same open client so Kysely runs every
  // statement (and its BEGIN/COMMIT) on the same per-test schema + transaction as the raw
  // helper queries; `release` is neutered so Kysely can't return the client to a real pool.
  const pool = {
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") {
            return () => undefined;
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as Database["pool"];

  return {
  pool,
  kysely: createKyselyDatabase(pool),
  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, params);
    return result.rows;
  },
  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const result = await client.query<T>(text, params);
    return result.rows[0] ?? null;
  },
  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const result = await client.query<T>(text, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected query to return one row");
    }
    return row;
  },
  async execute(text: string, params: unknown[] = []): Promise<number> {
    const result = await client.query(text, params);
    return result.rowCount ?? 0;
  },
  async withTransaction<T>(callback: (transactionClient: PoolClient) => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
  async close(): Promise<void> {},
} as Database;
};

const seedConversation = async (
  database: Database,
  conversationId = randomUUID(),
): Promise<{ accountId: string; conversationId: string; workspaceId: string }> => {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  await database.execute(
    `INSERT INTO accounts (id, name, email, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [accountId, "Operator", `${accountId}@example.test`, "hash"],
  );
  await database.execute(
    `INSERT INTO conversations (id, account_id)
     VALUES ($1, $2)`,
    [conversationId, accountId],
  );
  return { accountId, conversationId, workspaceId };
};

describeIfDatabase("ConversationOwnershipRepository Postgres integration", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let repository: ConversationOwnershipRepository;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `conversation_ownership_repo_${randomUUID().replaceAll("-", "_")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    database = createClientBackedDatabase(client);
    await applyTestMigration(database, "001_init.sql");
    await applyTestMigration(database, "105_conversation_ownership.sql");
    repository = new ConversationOwnershipRepository(database.kysely);
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE conversation_ownership, conversations, accounts CASCADE");
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
    }
    if (backingDatabase) {
      await backingDatabase.close();
    }
  });

  it("loads null for a conversation with no ownership row", async () => {
    const { conversationId } = await seedConversation(database);

    await expect(repository.load(conversationId)).resolves.toBeNull();
  });

  it("requests an unclaimed human handoff without clobbering an existing owner", async () => {
    const { conversationId, workspaceId } = await seedConversation(database);

    const requested = await repository.requestHandoff({
      conversationId,
      workspaceId,
      reason: "routine_handoff",
    });
    const secondRequest = await repository.requestHandoff({
      conversationId,
      workspaceId,
      reason: "retrieval_miss",
    });

    expect(requested).toMatchObject({
      conversationId,
      workspaceId,
      state: "human_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      reason: "routine_handoff",
      version: 1,
      takenOverAt: null,
    });
    expect(secondRequest).toEqual(requested);
  });

  it("takes over a conversation, then rejects a stale CAS takeover", async () => {
    const { conversationId, workspaceId } = await seedConversation(database);
    const firstOperator = randomUUID();
    const secondOperator = randomUUID();

    const claimed = await repository.takeOver({
      conversationId,
      workspaceId,
      accountId: firstOperator,
      displayName: "First Operator",
    });
    const stale = await repository.takeOver({
      conversationId,
      workspaceId,
      accountId: secondOperator,
      displayName: "Second Operator",
      expectedVersion: 1,
    });

    expect(claimed.ok).toBe(true);
    if (!claimed.ok) {
      throw new Error("Expected takeover to succeed");
    }
    expect(claimed.record).toMatchObject({
      conversationId,
      workspaceId,
      state: "human_owned",
      ownerAccountId: firstOperator,
      ownerDisplayName: "First Operator",
      reason: "operator_takeover",
      version: 1,
    });
    expect(claimed.record.takenOverAt).toBeInstanceOf(Date);
    expect(stale.ok).toBe(false);
    expect(stale.record).toEqual(claimed.record);
  });

  it("claims a requested handoff with CAS and bumps the version", async () => {
    const { conversationId, workspaceId } = await seedConversation(database);
    await repository.requestHandoff({ conversationId, workspaceId, reason: "routine_handoff" });

    const claimed = await repository.takeOver({
      conversationId,
      workspaceId,
      accountId: randomUUID(),
      displayName: "Ada Operator",
      expectedVersion: 1,
    });

    expect(claimed.ok).toBe(true);
    expect(claimed.record).toMatchObject({
      state: "human_owned",
      ownerDisplayName: "Ada Operator",
      reason: "operator_takeover",
      version: 2,
    });
  });

  it("transfers ownership with CAS", async () => {
    const { conversationId, workspaceId } = await seedConversation(database);
    const claimed = await repository.takeOver({
      conversationId,
      workspaceId,
      accountId: randomUUID(),
      displayName: "First Operator",
    });
    const nextOperator = randomUUID();

    if (!claimed.ok) {
      throw new Error("Expected takeover to succeed");
    }
    const transferred = await repository.transfer({
      conversationId,
      accountId: nextOperator,
      displayName: "Next Operator",
      expectedVersion: claimed.record.version,
    });

    expect(transferred.ok).toBe(true);
    if (!transferred.ok) {
      throw new Error("Expected transfer to succeed");
    }
    expect(transferred.record).toMatchObject({
      conversationId,
      state: "human_owned",
      ownerAccountId: nextOperator,
      ownerDisplayName: "Next Operator",
      version: claimed.record.version + 1,
    });
  });

  it("hands back ownership to the AI with CAS", async () => {
    const { conversationId, workspaceId } = await seedConversation(database);
    const claimed = await repository.takeOver({
      conversationId,
      workspaceId,
      accountId: randomUUID(),
      displayName: "Ada Operator",
    });

    if (!claimed.ok) {
      throw new Error("Expected takeover to succeed");
    }
    const handedBack = await repository.handBack({
      conversationId,
      expectedVersion: claimed.record.version,
    });

    expect(handedBack.ok).toBe(true);
    if (!handedBack.ok) {
      throw new Error("Expected hand-back to succeed");
    }
    expect(handedBack.record).toMatchObject({
      conversationId,
      workspaceId,
      state: "ai_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      version: claimed.record.version + 1,
    });
  });

  it("re-requests human ownership after a hand-back left the row ai_owned", async () => {
    const { conversationId, workspaceId } = await seedConversation(database);
    const claimed = await repository.takeOver({
      conversationId,
      workspaceId,
      accountId: randomUUID(),
      displayName: "Ada Operator",
    });
    if (!claimed.ok) {
      throw new Error("Expected takeover to succeed");
    }
    const handedBack = await repository.handBack({
      conversationId,
      expectedVersion: claimed.record.version,
    });
    if (!handedBack.ok) {
      throw new Error("Expected hand-back to succeed");
    }

    const reRequested = await repository.requestHandoff({
      conversationId,
      workspaceId,
      reason: "retrieval_miss",
    });

    expect(reRequested).toMatchObject({
      conversationId,
      workspaceId,
      state: "human_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      reason: "retrieval_miss",
      version: handedBack.record.version + 1,
    });
  });
});
