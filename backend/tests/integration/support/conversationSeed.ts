import { randomUUID } from "node:crypto";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import type { Database } from "../../../src/shared/infra/database.js";

/**
 * Seeds one account and workspace holding a conversation for each id, for tests of per-conversation
 * state (routine, clarification, directive, notification outcome rows) whose rows reference a real
 * conversation. Returns the workspace id.
 */
export const seedConversations = async (database: Database, conversationIds: readonly string[]): Promise<string> => {
  const account = await new AccountRepository(database.kysely).create({
    name: "Conversation Seed",
    email: `conversation-seed-${randomUUID()}@example.com`,
    passwordHash: "hash",
  });
  const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Conversation Seed Workspace");
  for (const conversationId of conversationIds) {
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [conversationId, workspace.id]);
  }
  return workspace.id;
};
