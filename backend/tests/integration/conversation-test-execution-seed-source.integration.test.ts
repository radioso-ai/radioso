import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ClarificationStateRepository } from "../../src/db/repositories/clarificationStateRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { DirectiveStateRepository } from "../../src/db/repositories/directiveStateRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import { ConversationTestExecutionSeedSource } from "../../src/modules/chat/services/conversationTestExecutionSeedSource.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Verifies the seed against real Postgres: the human-visible thread plus the conversation's
// live routine, clarification, and directive rows come back as one v1 continuation, keyed to
// no session, and nothing about the source changes.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ConversationTestExecutionSeedSource (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const clarificationStateRepository = new ClarificationStateRepository(database.kysely);
  const directiveStateRepository = new DirectiveStateRepository(database.kysely);
  const routineStateRepository = new RoutineStateRepository(database.kysely);
  const source = new ConversationTestExecutionSeedSource({
    conversations: new ConversationRepository(database.kysely),
    messages: new MessageRepository(database.kysely),
    routineStates: routineStateRepository,
    clarifications: clarificationStateRepository,
    directiveStates: directiveStateRepository,
  });

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const messageIds = { user: randomUUID(), assistant: randomUUID(), followUp: randomUUID() };
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId, "Seed Co", `acct-${accountId}@example.com`, "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId, accountId, "Seed Workspace", `route-${workspaceId.slice(0, 8)}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,$3)`, [agentId, workspaceId, "Seed Bot"]);
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1,$2,$3,$4)`,
      [conversationId, workspaceId, agentId, "website_embed"],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, source, created_at)
       VALUES
         ($1, $2, $3, 'system',    'system prompt',       'system',   $4),
         ($5, $2, $3, 'user',      'hello there',         'customer', $6),
         ($7, $2, $3, 'assistant', 'hi, how can I help?', 'ai_agent', $8),
         ($9, $2, $3, 'user',      'a follow-up',         'customer', $10)`,
      [
        randomUUID(), conversationId, workspaceId, "2026-06-01T09:00:00.000Z",
        messageIds.user, "2026-06-01T09:00:01.000Z",
        messageIds.assistant, "2026-06-01T09:00:02.000Z",
        messageIds.followUp, "2026-06-01T09:00:03.000Z",
      ],
    );
    // Live runtime position, all keyed by session_id == conversation id, written through the
    // same repositories a committed turn uses.
    await routineStateRepository.save({
      sessionId: conversationId,
      routineId: "kriya-courses",
      path: ["start", "collect_date"],
      variables: { date: "2026-07" },
      attempts: { collect_date: 1 },
      status: "active",
    });
    await clarificationStateRepository.save({
      sessionId: conversationId,
      source: "routine",
      originalQuery: "which course?",
      mode: "ask",
      candidates: [{ id: "morning", label: "Morning", confidence: 0.8, payload: { slot: "am" } }],
      status: "pending",
      expiresAt,
    });
    await directiveStateRepository.save({
      sessionId: conversationId,
      state: { turnSeq: 2, firings: { greet: { lastFiredTurn: 1, count: 1 } } },
    });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM routine_states WHERE session_id = $1`, [conversationId]).catch(() => undefined);
    await database.query(`DELETE FROM clarification_states WHERE session_id = $1`, [conversationId]).catch(() => undefined);
    await database.query(`DELETE FROM directive_states WHERE session_id = $1`, [conversationId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("seeds the thread and the live runtime position as a v1 continuation without touching the source", async () => {
    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(seed?.messages).toEqual([
      { role: "user", content: "hello there", messageId: messageIds.user, createdAt: new Date("2026-06-01T09:00:01.000Z") },
      { role: "assistant", content: "hi, how can I help?", messageId: messageIds.assistant, createdAt: new Date("2026-06-01T09:00:02.000Z") },
      { role: "user", content: "a follow-up", messageId: messageIds.followUp, createdAt: new Date("2026-06-01T09:00:03.000Z") },
    ]);
    expect(seed?.continuation).toMatchObject({
      version: 1,
      routineState: {
        routineId: "kriya-courses",
        path: ["start", "collect_date"],
        variables: { date: "2026-07" },
        attempts: { collect_date: 1 },
        status: "active",
      },
      pendingClarification: {
        source: "routine",
        originalQuery: "which course?",
        mode: "ask",
        status: "pending",
        candidates: [{ id: "morning", label: "Morning", confidence: 0.8, payload: { slot: "am" } }],
      },
      directiveState: { turnSeq: 2, firings: { greet: { lastFiredTurn: 1, count: 1 } } },
    });
    const continuation = seed?.continuation as { routineState: object; pendingClarification: object };
    expect(continuation.routineState).not.toHaveProperty("sessionId");
    expect(continuation.pendingClarification).not.toHaveProperty("sessionId");

    // The source keeps every row: its thread, its active routine, and its pending clarification.
    const messageCount = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1`, [conversationId],
    );
    expect(messageCount[0]?.count).toBe("4");
    await expect(routineStateRepository.loadActive({ sessionId: conversationId })).resolves.toMatchObject({ status: "active" });
    await expect(clarificationStateRepository.loadPending({ sessionId: conversationId })).resolves.toMatchObject({ status: "pending" });
  });

  it("answers null for a conversation in another workspace", async () => {
    await expect(source.loadSeed({ workspaceId: randomUUID(), agentId, conversationId })).resolves.toBeNull();
  });
});
