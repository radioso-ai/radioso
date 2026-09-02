import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { decodeCursorWithKeys, encodeCursor } from "../../src/shared/domain/cursorPagination.js";
import { Database } from "../../src/shared/infra/database.js";
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

describeIfDatabase("MessageRepository forward tail cursor", () => {
  let database: Database;
  let accounts: AccountRepository;
  let workspaces: WorkspaceRepository;
  let conversations: ConversationRepository;
  let messages: MessageRepository;
  const accountIds: string[] = [];

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    accounts = new AccountRepository(database.kysely);
    workspaces = new WorkspaceRepository(database.kysely);
    conversations = new ConversationRepository(database.kysely);
    messages = new MessageRepository(database.kysely);
  });

  afterEach(async () => {
    while (accountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountIds.pop()!]);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  const seedConversation = async () => {
    const account = await accounts.create({
      name: "Tail Test Account",
      email: `tail-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    accountIds.push(account.id);
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
