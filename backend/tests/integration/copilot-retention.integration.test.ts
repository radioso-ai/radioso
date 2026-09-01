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

  /**
   * Holds until the sweep's DELETE is actually waiting on the row lock. Without this the test
   * could commit first, leaving the sweep to take a snapshot that never saw the expired row — it
   * would pass for the wrong reason, and pass against the bug too.
   */
  const waitForBlockedDelete = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blocked = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE 'delete from%copilot_conversations%'`,
      );
      if (Number(blocked[0]?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The retention delete never blocked on the revived row; the race window never opened");
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

  // The bug this pins: the delete selects expired ids in a subquery, and if the outer statement
  // only matched on those ids, a conversation an operator revived after the snapshot was taken
  // would still be deleted — mid-turn, with its messages and proposals cascading away. Postgres
  // rechecks the outer qual against the updated row, so the cutoff has to be part of it.
  it("leaves a conversation an operator revived while the sweep was already running", async () => {
    const conversationId = await seedConversation(new Date("2026-01-01T00:00:00.000Z"));
    const cutoff = new Date("2026-06-01T00:00:00.000Z");
    const reviver = await database.pool.connect();

    try {
      // Uncommitted, so the sweep's snapshot still sees the row as expired and selects it, then
      // blocks trying to lock it — which is exactly the window the race needs.
      await reviver.query("BEGIN");
      await reviver.query(`UPDATE copilot_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);

      const sweep = repository.deleteConversationsUpdatedBefore({ cutoff, limit: 100 });
      await waitForBlockedDelete();
      await reviver.query("COMMIT");

      expect(await sweep).toBe(0);
    } finally {
      reviver.release();
    }

    const surviving = await database.query<{ id: string }>(
      `SELECT id FROM copilot_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(surviving).toHaveLength(1);
  });

  // Applying a proposal is activity on its conversation, and it is the one activity that mutates a
  // domain outside this table. Without re-dating the conversation, a sweep could delete it while
  // the apply was mid-flight: the domain change would land and the row that records the outcome
  // would already be gone, so the change would exist with nothing explaining it.
  it("keeps a conversation whose proposal an operator is applying", async () => {
    const conversationId = await seedConversation(new Date("2026-01-01T00:00:00.000Z"));
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

    const claim = await repository.claimProposalApply({
      id: proposal.id,
      workspaceId,
      operatorUserId,
      claimTtlSeconds: 300,
    });
    expect(claim).not.toBeNull();

    const deleted = await repository.deleteConversationsUpdatedBefore({
      cutoff: new Date("2026-06-01T00:00:00.000Z"),
      limit: 100,
    });

    expect(deleted).toBe(0);
    const surviving = await database.query<{ id: string }>(
      `SELECT id FROM copilot_proposals WHERE id = $1`,
      [proposal.id],
    );
    expect(surviving).toHaveLength(1);
  });

  // Dismissing is activity too. Apply re-dates the conversation through its claim; without the
  // same treatment here, an operator who cleared a stale proposal today would watch the whole
  // thread disappear on tonight's sweep.
  it("keeps a conversation whose proposal an operator has just dismissed", async () => {
    const conversationId = await seedConversation(new Date("2026-01-01T00:00:00.000Z"));
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

    const dismissed = await repository.updateProposalOutcome({
      id: proposal.id,
      workspaceId,
      operatorUserId,
      status: "dismissed",
      appliedRef: null,
      reason: null,
      applyClaimGuard: { state: "free", claimTtlSeconds: 300 },
    });
    expect(dismissed).not.toBeNull();

    const deleted = await repository.deleteConversationsUpdatedBefore({
      cutoff: new Date("2026-06-01T00:00:00.000Z"),
      limit: 100,
    });

    expect(deleted).toBe(0);
  });

  it("honours the batch limit so one sweep statement stays bounded", async () => {
    for (let index = 0; index < 3; index += 1) await seedConversation(new Date("2026-01-01T00:00:00.000Z"));

    const first = await repository.deleteConversationsUpdatedBefore({ cutoff: new Date("2026-06-01T00:00:00.000Z"), limit: 2 });
    const second = await repository.deleteConversationsUpdatedBefore({ cutoff: new Date("2026-06-01T00:00:00.000Z"), limit: 2 });

    expect(first).toBe(2);
    expect(second).toBe(1);
  });
});
