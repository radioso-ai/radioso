import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
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

describeIfDatabase("message source integration", () => {
  let database: Database;
  const accountIds: string[] = [];

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    while (accountIds.length > 0) {
      const accountId = accountIds.pop()!;
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    }
    await database.close();
  });

  it("adds the source column and reads back written message source", async () => {
    const sourceColumn = await database.queryOne<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'messages'
         AND column_name = 'source'`,
    );
    expect(sourceColumn).toEqual({ data_type: "text", is_nullable: "YES" });

    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database);
    const conversationRepository = new ConversationRepository(database.kysely);
    const messageRepository = new MessageRepository(database.kysely);

    const account = await accountRepository.create({
      email: `message-source-${randomUUID()}@example.com`,
      name: "Message Source",
      passwordHash: "hash",
    });
    accountIds.push(account.id);
    const workspace = await workspaceRepository.create(account.id, "Message Source Workspace");
    const conversation = await conversationRepository.create(workspace.id, null, "dashboard");

    const written = await messageRepository.create({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      role: "assistant",
      content: "Done.",
    });
    const messages = await messageRepository.listByConversationId(workspace.id, conversation.id);

    expect(written.source).toBe("ai_agent");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.source).toBe("ai_agent");
  });
});
