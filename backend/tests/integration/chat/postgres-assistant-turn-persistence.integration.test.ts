import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  const createdAccountIds = new Set<string>();
  const createdSessionIds = new Set<string>();

  const clearFixtures = async (): Promise<void> => {
    const sessionIds = [...createdSessionIds];
    if (sessionIds.length > 0) {
      await database.query("DELETE FROM clarification_states WHERE session_id = ANY($1::uuid[])", [sessionIds]);
      await database.query("DELETE FROM routine_states WHERE session_id = ANY($1::uuid[])", [sessionIds]);
    }

    const accountIds = [...createdAccountIds];
    if (accountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
    }

    createdAccountIds.clear();
    createdSessionIds.clear();
  };

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
    createdAccountIds.add(account.id);
    createdSessionIds.add(conversation.id);
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
    await clearFixtures();
    await database.close();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  afterEach(async () => {
    await clearFixtures();
  });

  it("persists routine attempts in the transactional routine state path", async () => {
    const { workspace, conversation } = await seedConversation();
    const sessionId = conversation.id;
    const assistantMessageId = randomUUID();

    const { message } = await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Saved.",
        grounding: {
          verdict: "degraded",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
        },
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
    expect(message.grounding).toEqual({
      verdict: "degraded",
      claimCount: 2,
      sourcedClaimCount: 1,
      unsourcedClaimCount: 1,
      invalidSourceCount: 0,
    });

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

  // This transactional path — not `ClarificationStateRepository.clear` — is what
  // production runs, because the deferred store applies clarification transitions
  // inside the assistant-turn transaction. The two must agree on retention.
  it.each([
    { outcome: "declined" as const, retained: true },
    { outcome: "expired" as const, retained: true },
    { outcome: "resolved" as const, retained: false },
  ])("a $outcome clear leaves the original query retained=$retained", async ({ outcome, retained }) => {
    const { workspace, conversation } = await seedConversation();
    const sessionId = conversation.id;
    const originalQuery = "How do I upload a document via the REST API?";

    const completeTurn = (transition: unknown) =>
      persistence.completeAssistantTurn({
        workspaceId: workspace.id,
        conversationId: conversation.id,
        assistantMessage: {
          id: randomUUID(),
          conversationId: conversation.id,
          workspaceId: workspace.id,
          role: "assistant",
          content: "...",
        },
        auditEvent: {
          eventType: "chat.answer",
          eventStatus: "success",
          workspaceId: workspace.id,
          metadata: {},
        },
        clarificationTransition: transition as never,
      });

    await completeTurn({
      kind: "save",
      pending: {
        sessionId,
        source: "retrieval_sense",
        originalQuery,
        mode: "ask",
        candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: {} }],
        askedEventId: randomUUID(),
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });

    await completeTurn({ kind: "clear", sessionId, outcome });

    const row = await database.queryOne<{ status: string; original_query: string | null }>(
      "SELECT status, original_query FROM clarification_states WHERE session_id = $1",
      [sessionId],
    );
    expect(row.status).toBe(outcome);
    expect(row.original_query).toBe(retained ? originalQuery : null);
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

  it("returns facts to a caller-owned transaction while leaving a later rollback silent and durable-state free", async () => {
    const { accountId, workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();
    let returnedFacts: Awaited<ReturnType<PostgresAssistantTurnPersistence["completeAssistantTurn"]>>["committedFacts"] | undefined;

    await expect(database.kysely.transaction().execute(async (transaction) => {
      const result = await persistence.completeAssistantTurn({
        workspaceId: workspace.id,
        accountId,
        conversationId: conversation.id,
        actions: [{ type: "contact.send", payload: { email: "visitor@example.com" } }],
        assistantMessage: {
          id: assistantMessageId,
          conversationId: conversation.id,
          workspaceId: workspace.id,
          role: "assistant",
          content: "This transaction will roll back.",
        },
        auditEvent: {
          eventType: "chat.answer",
          eventStatus: "success",
          workspaceId: workspace.id,
          metadata: {},
        },
        transaction,
      });
      returnedFacts = result.committedFacts;
      throw new Error("rollback requested");
    })).rejects.toThrow("rollback requested");

    expect(returnedFacts).toEqual({
      insertedActionTypes: ["contact.send"],
      decisionCreated: false,
      ownershipChanged: false,
    });
    const counts = await database.queryOne<{ messages: string; actions: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM messages WHERE id = $1) AS messages,
         (SELECT COUNT(*)::text FROM routine_action_requests WHERE conversation_id = $2) AS actions`,
      [assistantMessageId, conversation.id],
    );
    expect(counts).toEqual({ messages: "0", actions: "0" });
  });

  it("returns exact committed facts without translating them into product invalidations", async () => {
    const { accountId, workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();
    const result = await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      accountId,
      conversationId: conversation.id,
      actions: [{ type: "contact.send", payload: { email: "visitor@example.com" } }],
      ownershipHandoff: { reason: "needs_operator" },
      pendingDecisionTransition: {
        handle: `decision_${randomUUID()}`,
        conversationId: conversation.id,
        sessionId: conversation.id,
        workspaceId: workspace.id,
        agentId: randomUUID(),
        routineId: "routine_1",
        stepId: "approval",
        reason: "Needs review",
        options: [{ id: "approve", label: "Approve" }],
        deciderScope: { kind: "workspace_member" },
        contentHash: `sha256:${randomUUID()}`,
        deadline: null,
      },
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "I have handed this to an operator.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    expect(result.committedFacts).toEqual({
      insertedActionTypes: ["contact.send"],
      decisionCreated: true,
      ownershipChanged: true,
    });
    expect(result).not.toHaveProperty("postCommitReceipt");
  });

  it("does not report a duplicate contact action as newly inserted", async () => {
    const { accountId, workspace, conversation } = await seedConversation();
    const action = { type: "contact.send", payload: { email: "visitor@example.com" } };
    const complete = (messageId: string) => persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      accountId,
      conversationId: conversation.id,
      actions: [action],
      assistantMessage: {
        id: messageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Contact requested.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    const first = await complete(randomUUID());
    const duplicate = await complete(randomUUID());

    expect(first.committedFacts.insertedActionTypes).toEqual(["contact.send"]);
    expect(duplicate.committedFacts.insertedActionTypes).toEqual([]);
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

  // The action-outbox drain push (contact-outbox fix): the push must fire only after
  // the turn's own transaction has actually committed, never before or instead of it.
  it("requests an action drain push only after the turn transaction that enqueued the action commits", async () => {
    const { workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();
    const calls: string[] = [];
    const actionDrainDispatcher = {
      requestDrain: async () => {
        // At push time the enqueued row must already be visible to a fresh read —
        // proof the push happened after commit, not merely after the in-process
        // await resolved.
        const row = await database.queryOne<{ status: string }>(
          "SELECT status FROM routine_action_requests WHERE conversation_id = $1",
          [conversation.id],
        );
        calls.push(`requestDrain:${row.status}`);
      },
    };
    const persistenceWithPush = new PostgresAssistantTurnPersistence(database.kysely, 60_000, undefined, actionDrainDispatcher);

    await persistenceWithPush.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      actions: [{ type: "contact.send", payload: { email: "visitor@example.com", message: "hi" } }],
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Sent.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    expect(calls).toEqual(["requestDrain:pending"]);

    const enqueued = await database.queryOne<{ type: string; workspace_id: string }>(
      "SELECT type, workspace_id FROM routine_action_requests WHERE conversation_id = $1",
      [conversation.id],
    );
    expect(enqueued).toMatchObject({ type: "contact.send", workspace_id: workspace.id });
  });

  it("does not request an action drain push when the turn enqueued no actions", async () => {
    const { workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();
    const requestDrain = { called: 0 };
    const actionDrainDispatcher = { requestDrain: async () => { requestDrain.called += 1; } };
    const persistenceWithPush = new PostgresAssistantTurnPersistence(database.kysely, 60_000, undefined, actionDrainDispatcher);

    await persistenceWithPush.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "No action this turn.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    expect(requestDrain.called).toBe(0);
  });

  it("still returns the completed turn when the push itself fails (best-effort, never fails the turn)", async () => {
    const { workspace, conversation } = await seedConversation();
    const assistantMessageId = randomUUID();
    const actionDrainDispatcher = {
      requestDrain: async () => {
        throw new Error("cloud tasks unreachable");
      },
    };
    const persistenceWithPush = new PostgresAssistantTurnPersistence(database.kysely, 60_000, undefined, actionDrainDispatcher);

    const { message } = await persistenceWithPush.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      actions: [{ type: "contact.send", payload: { email: "visitor@example.com" } }],
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "Sent.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: {},
      },
    });

    expect(message.id).toBe(assistantMessageId);
    // The row is still durable even though the push failed — the interval poller /
    // recovery sweep remain the safety net.
    const enqueued = await database.queryOne<{ status: string }>(
      "SELECT status FROM routine_action_requests WHERE conversation_id = $1",
      [conversation.id],
    );
    expect(enqueued.status).toBe("pending");
  });
});
