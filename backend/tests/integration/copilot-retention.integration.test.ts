import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CopilotRepository } from "../../src/db/repositories/copilotRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("CopilotRepository retention sweep (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new CopilotRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const operatorUserId = randomUUID();

  const seedConversation = async (updatedAt: Date): Promise<string> => {
    const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: "Retention" });
    await database.query(`UPDATE copilot_conversations SET updated_at = $2 WHERE id = $1`, [conversation.id, updatedAt]);
    return conversation.id;
  };

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Copilot Retention Co",
      `copilot-retention-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Copilot Retention Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)`, [
      operatorUserId,
      `copilot-retention-operator-${operatorUserId}@example.com`,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM copilot_conversations WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = $1`, [operatorUserId]).catch(() => undefined);
    await database.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("removes only conversations last active before the cutoff", async () => {
    const expired = await seedConversation(new Date("2026-01-01T00:00:00.000Z"));
    const recent = await seedConversation(new Date("2026-08-30T00:00:00.000Z"));

    const deleted = await repository.deleteConversationsUpdatedBefore({
      cutoff: new Date("2026-06-01T00:00:00.000Z"),
      limit: 100,
    });

    expect(deleted).toBe(1);
    const remaining = await database.query<{ id: string }>(
      `SELECT id FROM copilot_conversations WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(remaining.map((row) => row.id)).toEqual([recent]);
    expect(remaining.map((row) => row.id)).not.toContain(expired);
  });

  it("takes the conversation's messages and proposals with it", async () => {
    const conversationId = await seedConversation(new Date("2026-01-01T00:00:00.000Z"));
    const message = await repository.createMessage({ conversationId, role: "operator", content: "Why is retrieval empty?" });
    const proposal = await repository.createProposal({
      workspaceId,
      operatorUserId,
      conversationId,
      targetType: "directive",
      targetRef: { agentId: randomUUID() },
      payload: { name: "Example" },
      versionToken: "v1",
      evidence: null,
    });

    await repository.deleteConversationsUpdatedBefore({ cutoff: new Date("2026-06-01T00:00:00.000Z"), limit: 100 });

    const messages = await database.query(`SELECT id FROM copilot_messages WHERE id = $1`, [message.id]);
    const proposals = await database.query(`SELECT id FROM copilot_proposals WHERE id = $1`, [proposal.id]);
    expect(messages).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });

  it("honours the batch limit so one sweep statement stays bounded", async () => {
    for (let index = 0; index < 3; index += 1) await seedConversation(new Date("2026-01-01T00:00:00.000Z"));

    const first = await repository.deleteConversationsUpdatedBefore({ cutoff: new Date("2026-06-01T00:00:00.000Z"), limit: 2 });
    const second = await repository.deleteConversationsUpdatedBefore({ cutoff: new Date("2026-06-01T00:00:00.000Z"), limit: 2 });

    expect(first).toBe(2);
    expect(second).toBe(1);
  });
});
