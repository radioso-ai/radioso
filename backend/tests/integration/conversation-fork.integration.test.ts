import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import { ConversationForkService } from "../../src/modules/chat/services/conversationForkService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Verifies forkForTest against real Postgres: the fork is an authenticated_chat test session
// carrying the source agent + the human-visible thread, while the source is left untouched.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ConversationForkService (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const conversationRepository = new ConversationRepository(database.kysely);
  const messageRepository = new MessageRepository(database.kysely);
  const routineStateRepository = new RoutineStateRepository(database.kysely);
  const service = new ConversationForkService(conversationRepository, messageRepository, routineStateRepository);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const sourceConversationId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Fork Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Fork Workspace",
      `route-${workspaceId.slice(0, 8)}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,$3)`, [
      agentId,
      workspaceId,
      "Fork Bot",
    ]);
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1,$2,$3,$4)`,
      [sourceConversationId, workspaceId, agentId, "website_embed"],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, source, created_at)
       VALUES
         ($1, $2, $3, 'system',    'system prompt',   'system',   $4),
         ($5, $2, $3, 'user',      'hello there',     'customer', $6),
         ($7, $2, $3, 'assistant', 'hi, how can I help?', 'ai_agent', $8),
         ($9, $2, $3, 'user',      'a follow-up',     'customer', $10)`,
      [
        randomUUID(),
        sourceConversationId,
        workspaceId,
        "2026-06-01T09:00:00.000Z",
        randomUUID(),
        "2026-06-01T09:00:01.000Z",
        randomUUID(),
        "2026-06-01T09:00:02.000Z",
        randomUUID(),
        "2026-06-01T09:00:03.000Z",
      ],
    );
    // Source conversation is mid-routine (active). session_id == conversation id.
    await database.query(
      `INSERT INTO routine_states (session_id, routine_id, path, variables, attempts, status)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'active')`,
      [
        sourceConversationId,
        "kriya-courses",
        ["start", "collect_date"],
        JSON.stringify({ date: "2026-07" }),
        JSON.stringify({ collect_date: 1 }),
      ],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("forks the thread into an authenticated_chat test session and leaves the source untouched", async () => {
    const { conversationId: forkId } = await service.forkForTest(workspaceId, sourceConversationId);

    // Fork conversation: new id, authenticated_chat channel, same agent + workspace.
    const fork = await conversationRepository.findByIdAndWorkspaceId(forkId, workspaceId);
    expect(forkId).not.toBe(sourceConversationId);
    expect(fork?.sourceChannel).toBe("authenticated_chat");
    expect(fork?.agentId).toBe(agentId);
    expect(fork?.workspaceId).toBe(workspaceId);

    // Only user + assistant messages copied, in order; system message skipped.
    const forkedMessages = await messageRepository.listByConversationId(workspaceId, forkId);
    expect(forkedMessages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi, how can I help?" },
      { role: "user", content: "a follow-up" },
    ]);
    expect(forkedMessages.map((m) => m.source)).toEqual(["customer", "ai_agent", "customer"]);

    // Source conversation + its messages are unchanged (system row still present).
    const source = await conversationRepository.findByIdAndWorkspaceId(sourceConversationId, workspaceId);
    expect(source?.sourceChannel).toBe("website_embed");
    const sourceMessages = await messageRepository.listByConversationId(workspaceId, sourceConversationId);
    expect(sourceMessages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("copies the active routine state onto the fork so it resumes mid-routine, leaving the source's state intact", async () => {
    const { conversationId: forkId } = await service.forkForTest(workspaceId, sourceConversationId);

    const forkState = await routineStateRepository.loadActive({ sessionId: forkId });
    expect(forkState).toMatchObject({
      sessionId: forkId,
      routineId: "kriya-courses",
      path: ["start", "collect_date"],
      variables: { date: "2026-07" },
      status: "active",
    });

    // The source's own routine row is untouched.
    const sourceState = await routineStateRepository.loadActive({ sessionId: sourceConversationId });
    expect(sourceState?.sessionId).toBe(sourceConversationId);
  });

  it("throws for a conversation outside the caller's workspace", async () => {
    await expect(service.forkForTest(randomUUID(), sourceConversationId)).rejects.toThrow();
  });
});
