import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { decodeCursorWithKeys, encodeCursor } from "../../src/shared/domain/cursorPagination.js";
import { Database } from "../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../src/shared/infra/kysely/kyselyDatabase.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

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
  // Kysely over the same single client, so migrated repos used for seeding share this
  // test's dedicated schema/search_path.
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

describeIfDatabase("MessageRepository forward tail cursor", () => {
  let backingDatabase: Database;
  let database: Database;
  let client: PoolClient;
  let schema: string;
  let accounts: AccountRepository;
  let workspaces: WorkspaceRepository;
  let conversations: ConversationRepository;
  let messages: MessageRepository;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `message_repo_tail_${randomUUID().replaceAll("-", "_")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    database = createClientBackedDatabase(client);
    await runAllTestMigrations(database);
    accounts = new AccountRepository(database.kysely);
    workspaces = new WorkspaceRepository(database);
    conversations = new ConversationRepository(database);
    messages = new MessageRepository(database);
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE accounts CASCADE");
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

  const seedConversation = async () => {
    const account = await accounts.create({
      name: "Tail Test Account",
      email: `tail-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaces.create(account.id, "Tail Test Workspace");
    const conversation = await conversations.create(workspace.id);
    return { workspace, conversation };
  };

  const setMessageTime = async (id: string, createdAt: string) => {
    await database.execute("UPDATE messages SET created_at = $2::timestamptz WHERE id = $1", [id, createdAt]);
  };

  it("returns the newest bounded messages and newest cursor when no cursor is supplied", async () => {
    const { workspace, conversation } = await seedConversation();
    const first = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "first",
    });
    const second = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "second",
    });
    await setMessageTime(first.id, "2026-06-01T00:00:00.000Z");
    await setMessageTime(second.id, "2026-06-01T00:00:01.000Z");

    const page = await messages.listSinceByConversationId(workspace.id, conversation.id, { limit: 10 });

    expect(page.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(page.latestCursor).toBeTruthy();
    expect(decodeCursorWithKeys(page.latestCursor!, ["createdAt", "id"]).keys).toEqual({
      createdAt: "2026-06-01T00:00:01.000Z",
      id: second.id,
    });
  });

  it("limits no-cursor tails to the newest page", async () => {
    const { workspace, conversation } = await seedConversation();
    const first = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "first",
    });
    const second = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "second",
    });
    await setMessageTime(first.id, "2026-06-01T00:00:00.000Z");
    await setMessageTime(second.id, "2026-06-01T00:00:01.000Z");

    const page = await messages.listSinceByConversationId(workspace.id, conversation.id, { limit: 1 });

    expect(page.messages.map((message) => message.id)).toEqual([second.id]);
    expect(decodeCursorWithKeys(page.latestCursor!, ["createdAt", "id"]).keys.id).toBe(second.id);
  });

  it("returns only messages strictly after the cursor in deterministic forward order", async () => {
    const { workspace, conversation } = await seedConversation();
    const older = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "older",
    });
    const cursorMessage = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "cursor",
    });
    const sameTimeHigherId = await messages.create({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "same time higher id",
    });
    const newer = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "newer",
    });
    await setMessageTime(older.id, "2026-06-01T00:00:00.000Z");
    await setMessageTime(cursorMessage.id, "2026-06-01T00:00:01.000Z");
    await setMessageTime(sameTimeHigherId.id, "2026-06-01T00:00:01.000Z");
    await setMessageTime(newer.id, "2026-06-01T00:00:02.000Z");

    const page = await messages.listSinceByConversationId(workspace.id, conversation.id, {
      sinceCreatedAt: new Date("2026-06-01T00:00:01.000Z"),
      sinceId: cursorMessage.id,
      limit: 10,
    });

    expect(page.messages.map((message) => message.id)).toEqual([sameTimeHigherId.id, newer.id]);
    expect(page.latestCursor).toBeTruthy();
    expect(decodeCursorWithKeys(page.latestCursor!, ["createdAt", "id"]).keys).toEqual({
      createdAt: "2026-06-01T00:00:02.000Z",
      id: newer.id,
    });
  });

  it("respects limit and advances the cursor to the last returned row", async () => {
    const { workspace, conversation } = await seedConversation();
    const first = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "first",
    });
    const second = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "second",
    });
    const third = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "third",
    });
    await setMessageTime(first.id, "2026-06-01T00:00:00.000Z");
    await setMessageTime(second.id, "2026-06-01T00:00:01.000Z");
    await setMessageTime(third.id, "2026-06-01T00:00:02.000Z");

    const page = await messages.listSinceByConversationId(workspace.id, conversation.id, {
      sinceCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
      sinceId: first.id,
      limit: 1,
    });

    expect(page.messages.map((message) => message.id)).toEqual([second.id]);
    expect(decodeCursorWithKeys(page.latestCursor!, ["createdAt", "id"]).keys.id).toBe(second.id);
  });

  it("continues after a limit-capped page and eventually drains", async () => {
    const { workspace, conversation } = await seedConversation();
    const first = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "first",
    });
    const second = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "second",
    });
    const third = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "assistant",
      content: "third",
    });
    const fourth = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "fourth",
    });
    await setMessageTime(first.id, "2026-06-01T00:00:00.000Z");
    await setMessageTime(second.id, "2026-06-01T00:00:01.000Z");
    await setMessageTime(third.id, "2026-06-01T00:00:02.000Z");
    await setMessageTime(fourth.id, "2026-06-01T00:00:03.000Z");

    const firstPage = await messages.listSinceByConversationId(workspace.id, conversation.id, {
      sinceCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
      sinceId: first.id,
      limit: 1,
    });
    const firstPageCursor = decodeCursorWithKeys(firstPage.latestCursor!, ["createdAt", "id"]).keys;

    const secondPage = await messages.listSinceByConversationId(workspace.id, conversation.id, {
      sinceCreatedAt: new Date(firstPageCursor.createdAt),
      sinceId: firstPageCursor.id,
      limit: 10,
    });
    const secondPageCursor = decodeCursorWithKeys(secondPage.latestCursor!, ["createdAt", "id"]).keys;

    const drained = await messages.listSinceByConversationId(workspace.id, conversation.id, {
      sinceCreatedAt: new Date(secondPageCursor.createdAt),
      sinceId: secondPageCursor.id,
      limit: 10,
    });

    expect(firstPage.messages.map((message) => message.id)).toEqual([second.id]);
    expect(firstPageCursor.id).toBe(second.id);
    expect(secondPage.messages.map((message) => message.id)).toEqual([third.id, fourth.id]);
    expect(secondPageCursor.id).toBe(fourth.id);
    expect(drained.messages).toEqual([]);
    expect(decodeCursorWithKeys(drained.latestCursor!, ["createdAt", "id"]).keys.id).toBe(fourth.id);
  });

  it("returns empty and keeps the newest cursor when no messages are newer", async () => {
    const { workspace, conversation } = await seedConversation();
    const latest = await messages.create({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      role: "user",
      content: "latest",
    });
    await setMessageTime(latest.id, "2026-06-01T00:00:00.000Z");

    const cursor = encodeCursor({
      createdAt: "2026-06-01T00:00:00.000Z",
      id: latest.id,
    });
    const page = await messages.listSinceByConversationId(workspace.id, conversation.id, {
      sinceCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
      sinceId: latest.id,
      limit: 10,
    });

    expect(page.messages).toEqual([]);
    expect(page.latestCursor).toBe(cursor);
  });
});
