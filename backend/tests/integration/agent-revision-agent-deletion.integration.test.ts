import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("agent revision deletion compatibility (Postgres)", () => {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const revisionId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  let database: Database;

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "deletion compatibility", `deletion-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "deletion compatibility", `deletion-${workspaceId}`],
    );
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Deleted agent"]);
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version) VALUES ($1, $2, $3, $4::jsonb, 1, now(), 1)",
      [revisionId, agentId, workspaceId, JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] })],
    );
    await database.query("UPDATE agents SET published_revision_id = $1 WHERE id = $2", [revisionId, agentId]);
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, agent_revision_id) VALUES ($1, $2, $3, $4)",
      [conversationId, workspaceId, agentId, revisionId],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, $4, $5)",
      [messageId, conversationId, workspaceId, "user", "Keep this history"],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("deletes the agent while retaining its conversation history without a stale revision pin", async () => {
    const agents = new AgentRepository(database.kysely);

    await expect(agents.deleteByIdAndWorkspaceId(agentId, workspaceId)).resolves.toBe(true);
    const [conversation] = await database.query<{ agent_id: string | null; agent_revision_id: string | null }>(
      "SELECT agent_id, agent_revision_id FROM conversations WHERE id = $1",
      [conversationId],
    );

    expect(conversation).toEqual({ agent_id: null, agent_revision_id: null });
    await expect(database.query<{ content: string }>("SELECT content FROM messages WHERE id = $1", [messageId]))
      .resolves.toEqual([{ content: "Keep this history" }]);
  });
});
