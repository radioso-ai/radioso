import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { ConversationRepository, type ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import { ConversationOwnershipRepository } from "../../../src/db/repositories/conversationOwnershipRepository.js";
import { WorkspaceRepository, type WorkspaceRecord } from "../../../src/db/repositories/workspaceRepository.js";
import { PostgresAssistantTurnPersistence } from "../../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { Database } from "../../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../../support/databaseMigrations.js";

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

describeIfDatabase("PostgresAssistantTurnPersistence Kysely integration", () => {
  let database: Database;
  let accounts: AccountRepository;
  let workspaces: WorkspaceRepository;
  let conversations: ConversationRepository;
  let persistence: PostgresAssistantTurnPersistence;

  const seedConversation = async (): Promise<{
    accountId: string;
    workspace: WorkspaceRecord;
    conversation: ConversationRecord;
  }> => {
    const account = await accounts.create({
      name: "Turn Persistence Test",
      email: `turn-persistence-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaces.create(account.id, "Turn Persistence Workspace");
    const conversation = await conversations.create(workspace.id);
    return { accountId: account.id, workspace, conversation };
  };

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    accounts = new AccountRepository(database.kysely);
    workspaces = new WorkspaceRepository(database.kysely);
    conversations = new ConversationRepository(database.kysely);
    persistence = new PostgresAssistantTurnPersistence(database.kysely, 60_000);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE clarification_states, routine_states CASCADE");
  });

  it("persists routine attempts in the transactional routine state path", async () => {
    const { workspace, conversation } = await seedConversation();
    const sessionId = conversation.id;
    const assistantMessageId = randomUUID();

    const message = await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Saved.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
      routineStateTransition: {
        kind: "save",
        state: {
          sessionId,
          routineId: "routine_1",
          path: ["ask_email", "ask_message"],
          variables: { email: "alex@example.com" },
          attempts: { ask_email: 1, ask_message: 2 },
          status: "active",
        },
      },
    });

    expect(message.id).toBe(assistantMessageId);

    const savedState = await database.queryOne<{
      status: string;
      attempts: unknown;
      path: string[];
      variables: unknown;
      expires_at: Date | null;
    }>(
      "SELECT status, attempts, path, variables, expires_at FROM routine_states WHERE session_id = $1",
      [sessionId],
    );
    expect(savedState).toMatchObject({
      status: "active",
      attempts: { ask_email: 1, ask_message: 2 },
      path: ["ask_email", "ask_message"],
      variables: { email: "alex@example.com" },
    });
    // active (not suspended) state gets a TTL-derived expiry, never null
    expect(savedState.expires_at).toBeInstanceOf(Date);
  });

  it("applies clarification transitions inside the assistant turn transaction", async () => {
    const { workspace, conversation } = await seedConversation();
    const sessionId = conversation.id;
    const assistantMessageId = randomUUID();

    await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Which one?",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId,
          source: "test_surface",
          originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
          mode: "ask",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
          askedEventId: assistantMessageId,
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
    });

    const savedClarification = await database.queryOne<{
      source: string;
      original_query: string | null;
      mode: string;
      candidates: unknown;
      status: string;
    }>(
      "SELECT source, original_query, mode, candidates, status FROM clarification_states WHERE session_id = $1",
      [sessionId],
    );
    expect(savedClarification).toMatchObject({
      source: "test_surface",
      original_query: "How do I upload a document via the REST API? Give me a curl example.",
      mode: "ask",
      candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
      status: "pending",
    });

    // The clarification row and the assistant message committed together (same turn txn).
    const savedMessage = await database.queryOne<{ id: string }>(
      "SELECT id FROM messages WHERE id = $1",
      [assistantMessageId],
    );
    expect(savedMessage.id).toBe(assistantMessageId);
  });

  it("requests ownership handoff and records ownership audit inside the assistant turn transaction", async () => {
    const { workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();

    await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "A person will help you from here.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
      ownershipHandoff: { reason: "routine_handoff", routineId: "routine_1", stepId: "handoff" },
      ownershipAuditEvent: {
        eventType: "hitl.ownership",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {
          action: "handoff_requested",
          conversationId: conversation.id,
          routineId: "routine_1",
          stepId: "handoff",
        },
      },
    });

    // Ownership handoff ran on the same transaction and committed.
    const ownership = new ConversationOwnershipRepository(database.kysely);
    const record = await ownership.load(conversation.id);
    expect(record).toMatchObject({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      state: "human_owned",
      reason: "routine_handoff",
    });

    // Both the turn audit event and the ownership audit event were inserted.
    const auditCount = await database.queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND event_type = ANY($2::text[])",
      [workspace.id, ["chat.answer", "hitl.ownership"]],
    );
    expect(Number(auditCount.count)).toBe(2);

    const ownershipAudit = await database.queryOne<{ event_type: string }>(
      "SELECT event_type FROM audit_events WHERE workspace_id = $1 AND event_type = 'hitl.ownership'",
      [workspace.id],
    );
    expect(ownershipAudit.event_type).toBe("hitl.ownership");
  });

  // This transactional raw INSERT is the second write path for assistant turns
  // (MessageRepository.create is the other). A column wired on only one of them is
  // NULL for half the traffic, so the persister gets its own assertion.
  it("persists total_latency_ms from the assistant message payload", async () => {
    const { workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();

    await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Timed answer.",
        totalLatencyMs: 2450,
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    const stored = await database.queryOne<{ total_latency_ms: number | null }>(
      "SELECT total_latency_ms FROM messages WHERE id = $1",
      [assistantMessageId],
    );
    expect(stored.total_latency_ms).toBe(2450);
  });

  it("leaves total_latency_ms null when the turn payload carries no latency", async () => {
    const { workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();

    await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Untimed answer.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    const stored = await database.queryOne<{ total_latency_ms: number | null }>(
      "SELECT total_latency_ms FROM messages WHERE id = $1",
      [assistantMessageId],
    );
    expect(stored.total_latency_ms).toBeNull();
  });
});
