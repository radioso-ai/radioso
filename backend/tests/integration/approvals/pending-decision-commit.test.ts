import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoutineState } from "@radioso/conversation-contract";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { ConversationRepository, type ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import {
  PendingDecisionRepository,
  type PendingDecisionCreateInput,
} from "../../../src/db/repositories/pendingDecisionRepository.js";
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

const routineState = (sessionId: string, overrides: Partial<RoutineState> = {}): RoutineState => ({
  sessionId,
  routineId: "routine.operator-review",
  path: ["collect_input", "await_approval"],
  variables: { customerId: "customer-123" },
  attempts: { collect_input: 1 },
  status: "suspended",
  ...overrides,
});

const pendingDecisionInput = (
  workspaceId: string,
  conversationId: string,
  sessionId: string,
  overrides: Partial<PendingDecisionCreateInput> = {},
): PendingDecisionCreateInput => ({
  handle: `decision_${randomUUID()}`,
  conversationId,
  sessionId,
  workspaceId,
  agentId: randomUUID(),
  routineId: "routine.operator-review",
  stepId: "await_approval",
  reason: "Needs operator approval before continuing.",
  options: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  deciderScope: { kind: "workspace_role", role: "admin" },
  contentHash: `sha256:${randomUUID()}`,
  deadline: null,
  ...overrides,
});

describeIfDatabase("pending decision assistant-turn commit fence", () => {
  let database: Database;
  let accounts: AccountRepository;
  let workspaces: WorkspaceRepository;
  let conversations: ConversationRepository;
  let pendingDecisions: PendingDecisionRepository;
  let persistence: PostgresAssistantTurnPersistence;

  const seedConversation = async (): Promise<{
    accountId: string;
    workspace: WorkspaceRecord;
    conversation: ConversationRecord;
  }> => {
    const account = await accounts.create({
      name: "Pending Decision Commit Test",
      email: `pending-decision-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaces.create(account.id, "Pending Decision Workspace");
    const conversation = await conversations.create(workspace.id);

    return { accountId: account.id, workspace, conversation };
  };

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    accounts = new AccountRepository(database);
    workspaces = new WorkspaceRepository(database);
    conversations = new ConversationRepository(database);
    pendingDecisions = new PendingDecisionRepository(database);
    persistence = new PostgresAssistantTurnPersistence(database, 60_000);
  });

  afterAll(async () => {
    await database.close();
  });

  it("atomically commits a suspended routine state, pending decision, and assistant message", async () => {
    const { workspace, conversation } = await seedConversation();
    const sessionId = randomUUID();
    const decision = pendingDecisionInput(workspace.id, conversation.id, sessionId);
    const assistantMessageId = randomUUID();

    const message = await persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      routineStateTransition: {
        kind: "save",
        state: routineState(sessionId),
      },
      pendingDecisionTransition: decision,
      actions: [
        {
          type: "approval.request",
          payload: { handle: decision.handle, conversationId: conversation.id, workspaceId: workspace.id },
        },
      ],
      assistantMessage: {
        id: assistantMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "I need approval before continuing.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: { assistantMessageId },
      },
    });

    expect(message.id).toBe(assistantMessageId);

    const savedState = await database.queryOne<{
      session_id: string;
      status: string;
      expires_at: Date | null;
      attempts: unknown;
    }>(
      `SELECT session_id, status, expires_at, attempts
         FROM routine_states
        WHERE session_id = $1`,
      [sessionId],
    );
    expect(savedState).toMatchObject({
      session_id: sessionId,
      status: "suspended",
      expires_at: null,
      attempts: { collect_input: 1 },
    });

    const loadedDecision = await pendingDecisions.loadByHandle(decision.handle);
    expect(loadedDecision).toMatchObject({
      handle: decision.handle,
      conversationId: conversation.id,
      sessionId,
      workspaceId: workspace.id,
      routineId: decision.routineId,
      stepId: decision.stepId,
      status: "pending",
      options: decision.options,
      deciderScope: decision.deciderScope,
      contentHash: decision.contentHash,
    });

    const savedMessage = await database.queryOne<{ id: string; content: string }>(
      `SELECT id, content FROM messages WHERE id = $1`,
      [assistantMessageId],
    );
    expect(savedMessage).toEqual({
      id: assistantMessageId,
      content: "I need approval before continuing.",
    });

    // The approval.request notification is enqueued in the same commit as the decision.
    const actionRow = await database.queryOne<{ type: string; payload: { handle?: string } }>(
      `SELECT type, payload FROM routine_action_requests WHERE conversation_id = $1`,
      [conversation.id],
    );
    expect(actionRow.type).toBe("approval.request");
    expect(actionRow.payload.handle).toBe(decision.handle);
  });

  it("rolls back routine state and pending decision when the assistant message insert fails", async () => {
    const { workspace, conversation } = await seedConversation();
    const sessionId = randomUUID();
    const decision = pendingDecisionInput(workspace.id, conversation.id, sessionId);
    const duplicateMessageId = randomUUID();

    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
       VALUES ($1, $2, $3, 'assistant', 'preexisting message')`,
      [duplicateMessageId, conversation.id, workspace.id],
    );

    await expect(persistence.completeAssistantTurn({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      routineStateTransition: {
        kind: "save",
        state: routineState(sessionId),
      },
      pendingDecisionTransition: decision,
      actions: [
        {
          type: "approval.request",
          payload: { handle: decision.handle, conversationId: conversation.id, workspaceId: workspace.id },
        },
      ],
      assistantMessage: {
        id: duplicateMessageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        role: "assistant",
        content: "This insert should fail.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: workspace.id,
        metadata: { assistantMessageId: duplicateMessageId },
      },
    })).rejects.toThrow();

    const routineStateCount = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM routine_states WHERE session_id = $1`,
      [sessionId],
    );
    expect(routineStateCount.count).toBe("0");

    await expect(pendingDecisions.loadByHandle(decision.handle)).resolves.toBeNull();

    // The notification must roll back with the decision — it can never outlive a lost gate.
    const actionCount = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM routine_action_requests WHERE conversation_id = $1`,
      [conversation.id],
    );
    expect(actionCount.count).toBe("0");

    const messageCount = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages WHERE id = $1`,
      [duplicateMessageId],
    );
    expect(messageCount.count).toBe("1");
  });
});
