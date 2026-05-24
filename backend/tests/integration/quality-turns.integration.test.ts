import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { QualityTurnsService } from "../../src/modules/quality/service.js";

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

describeIfDatabase("quality turns integration", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsPath = path.resolve(__dirname, "../../src/db/migrations");

  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    const files = (await readdir(migrationsPath)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsPath, file), "utf8");
      await database.pool.query(sql);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it("surfaces non-grounded refusals and thumbs-down feedback by default", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const groundedConversationId = randomUUID();
    const refusalConversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "QA Account", `qa-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "QA Workspace", `qa-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Support Bot"],
    );

    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, $4)`,
      [groundedConversationId, workspaceId, agentId, "embed"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, $4)`,
      [refusalConversationId, workspaceId, agentId, "embed"],
    );

    const groundedUserMessageId = randomUUID();
    const groundedAssistantMessageId = randomUUID();
    const refusalUserMessageId = randomUUID();
    const refusalAssistantMessageId = randomUUID();

    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, answer_outcome, created_at)
       VALUES
         ($1, $2, $3, 'user',      'What is the refund policy?', NULL,                $4),
         ($5, $2, $3, 'assistant', 'Refunds are processed within 7 days.', 'grounded_success', $6),
         ($7, $8, $3, 'user',      'What is the capital of Mars?', NULL,                $9),
         ($10, $8, $3, 'assistant', 'I do not have information about that.', 'no_context_refusal', $11)`,
      [
        groundedUserMessageId,
        groundedConversationId,
        workspaceId,
        "2026-05-20T09:00:00.000Z",
        groundedAssistantMessageId,
        "2026-05-20T09:00:01.000Z",
        refusalUserMessageId,
        refusalConversationId,
        "2026-05-21T09:00:00.000Z",
        refusalAssistantMessageId,
        "2026-05-21T09:00:01.000Z",
      ],
    );

    await database.query(
      `INSERT INTO assistant_answer_feedback
         (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value, comment)
       VALUES
         ($1, $2, $3, $4, 'authenticated_user', 'user-1', 'down', 'Did not help')`,
      [randomUUID(), workspaceId, groundedConversationId, groundedAssistantMessageId],
    );

    const service = new QualityTurnsService(database);
    const page = await service.listLowQualityTurns(workspaceId, { limit: 25 });

    const ids = page.items.map((item) => item.assistantMessageId);
    expect(ids).toContain(refusalAssistantMessageId);
    expect(ids).toContain(groundedAssistantMessageId);

    const refusal = page.items.find((item) => item.assistantMessageId === refusalAssistantMessageId);
    expect(refusal?.answerOutcome).toBe("no_context_refusal");
    expect(refusal?.question).toBe("What is the capital of Mars?");
    expect(refusal?.agentName).toBe("Support Bot");
    expect(refusal?.channel).toBe("embed");
    expect(refusal?.feedback).toEqual({ upCount: 0, downCount: 0, comments: [] });

    const grounded = page.items.find((item) => item.assistantMessageId === groundedAssistantMessageId);
    expect(grounded?.feedback.downCount).toBe(1);
    expect(grounded?.feedback.comments).toEqual([
      expect.objectContaining({ value: "down", comment: "Did not help" }),
    ]);
  });

  it("filters by outcome and feedback value, and scopes to workspace", async () => {
    const accountId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const agentId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Filter Account", `filter-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceA, accountId, "WS A", `wa-${workspaceA.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceB, accountId, "WS B", `wb-${workspaceB.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceA, "Filter Bot"],
    );

    const conversationA = randomUUID();
    const conversationB = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'dashboard')`,
      [conversationA, workspaceA, agentId],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, NULL, 'dashboard')`,
      [conversationB, workspaceB],
    );

    const messageInWorkspaceA = randomUUID();
    const messageInWorkspaceB = randomUUID();

    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, answer_outcome, created_at)
       VALUES
         ($1, $2, $3, 'assistant', 'A refusal', 'no_context_refusal', $4),
         ($5, $6, $7, 'assistant', 'B refusal', 'no_context_refusal', $8)`,
      [
        messageInWorkspaceA,
        conversationA,
        workspaceA,
        "2026-05-22T09:00:00.000Z",
        messageInWorkspaceB,
        conversationB,
        workspaceB,
        "2026-05-22T09:00:00.000Z",
      ],
    );

    const service = new QualityTurnsService(database);
    const page = await service.listLowQualityTurns(workspaceA, {
      limit: 25,
      outcomes: ["no_context_refusal"],
    });

    const ids = page.items.map((item) => item.assistantMessageId);
    expect(ids).toContain(messageInWorkspaceA);
    expect(ids).not.toContain(messageInWorkspaceB);
  });
});
