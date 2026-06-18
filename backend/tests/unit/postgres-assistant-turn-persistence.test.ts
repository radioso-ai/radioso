import { describe, expect, it, vi } from "vitest";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import type { Database } from "../../src/shared/infra/database.js";

type QueryCall = [sql: string, params?: unknown[]];

const queryResult = <T extends QueryResultRow>(rows: T[]): QueryResult<T> => ({
  rows,
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
});

describe("PostgresAssistantTurnPersistence", () => {
  it("persists routine attempts in the transactional routine state path", async () => {
    const calls: QueryCall[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params]);
        if (sql.includes("RETURNING id, conversation_id")) {
          return queryResult([{
            id: "assistant_msg_1",
            conversation_id: "conv_1",
            workspace_id: "workspace_1",
            role: "assistant",
            content: "Saved.",
            metadata_json: {},
            skill_name: null,
            skill_outcome: null,
            skill_status: null,
            created_at: new Date("2026-06-09T00:00:00.000Z"),
          }]);
        }
        return queryResult([]);
      }),
    };
    const database = {
      withTransaction: vi.fn(async (callback: (transactionClient: PoolClient) => Promise<unknown>) =>
        callback(client as unknown as PoolClient)
      ),
    } as unknown as Database;

    await new PostgresAssistantTurnPersistence(database, 60_000).completeAssistantTurn({
      workspaceId: "workspace_1",
      conversationId: "conv_1",
      assistantMessage: {
        id: "assistant_msg_1",
        conversationId: "conv_1",
        workspaceId: "workspace_1",
        role: "assistant",
        content: "Saved.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: "workspace_1",
        metadata: {},
      },
      routineStateTransition: {
        kind: "save",
        state: {
          sessionId: "conv_1",
          routineId: "routine_1",
          path: ["ask_email", "ask_message"],
          variables: { email: "alex@example.com" },
          attempts: { ask_email: 1, ask_message: 2 },
          status: "active",
        },
      },
    });

    const routineStateCall = calls.find(([sql]) => sql.includes("INSERT INTO routine_states"));
    expect(routineStateCall).toBeDefined();
    const [sql, params] = routineStateCall!;
    expect(sql).toContain("(session_id, routine_id, path, variables, attempts, status, expires_at, updated_at)");
    expect(sql).toContain("attempts = EXCLUDED.attempts");
    expect(params?.[4]).toBe(JSON.stringify({ ask_email: 1, ask_message: 2 }));
    expect(params?.[5]).toBe("active");
  });

  it("applies clarification transitions inside the assistant turn transaction", async () => {
    const calls: QueryCall[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params]);
        if (sql.includes("RETURNING id, conversation_id")) {
          return queryResult([{
            id: "assistant_msg_1",
            conversation_id: "conv_1",
            workspace_id: "workspace_1",
            role: "assistant",
            content: "Which one?",
            metadata_json: {},
            skill_name: null,
            skill_outcome: null,
            skill_status: null,
            created_at: new Date("2026-06-09T00:00:00.000Z"),
          }]);
        }
        return queryResult([]);
      }),
    };
    const database = {
      withTransaction: vi.fn(async (callback: (transactionClient: PoolClient) => Promise<unknown>) =>
        callback(client as unknown as PoolClient)
      ),
    } as unknown as Database;

    await new PostgresAssistantTurnPersistence(database, 60_000).completeAssistantTurn({
      workspaceId: "workspace_1",
      conversationId: "conv_1",
      assistantMessage: {
        id: "assistant_msg_1",
        conversationId: "conv_1",
        workspaceId: "workspace_1",
        role: "assistant",
        content: "Which one?",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: "workspace_1",
        metadata: {},
      },
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
          mode: "ask",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
          askedEventId: "assistant_msg_1",
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
    });

    const clarificationCall = calls.find(([sql]) => sql.includes("INSERT INTO clarification_states"));
    expect(clarificationCall).toBeDefined();
    expect(calls.findIndex(([sql]) => sql.includes("INSERT INTO clarification_states")))
      .toBeLessThan(calls.findIndex(([sql]) => sql.includes("INSERT INTO messages")));
    expect(clarificationCall![0]).toContain("original_query");
    expect(clarificationCall![1]?.[2]).toBe("How do I upload a document via the REST API? Give me a curl example.");
    expect(clarificationCall![1]?.[3]).toBe("ask");
    expect(clarificationCall![1]?.[4]).toBe(JSON.stringify([
      { id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } },
    ]));
  });

  it("requests ownership handoff and records ownership audit inside the assistant turn transaction", async () => {
    const calls: QueryCall[] = [];
    let insideTransaction = false;
    const handoffCallWasInsideTransaction = { value: false };
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params]);
        if (sql.includes("RETURNING id, conversation_id")) {
          return queryResult([{
            id: "assistant_msg_1",
            conversation_id: "conv_1",
            workspace_id: "workspace_1",
            role: "assistant",
            content: "A person will help you from here.",
            metadata_json: {},
            skill_name: null,
            skill_outcome: null,
            skill_status: null,
            created_at: new Date("2026-06-09T00:00:00.000Z"),
          }]);
        }
        return queryResult([]);
      }),
    };
    const database = {
      withTransaction: vi.fn(async (callback: (transactionClient: PoolClient) => Promise<unknown>) => {
        insideTransaction = true;
        try {
          return await callback(client as unknown as PoolClient);
        } finally {
          insideTransaction = false;
        }
      }),
    } as unknown as Database;
    const conversationOwnershipRepository = {
      requestHandoff: vi.fn(async (_input, executor) => {
        handoffCallWasInsideTransaction.value = insideTransaction;
        await executor?.queryOptional("SELECT 1", []);
        return null;
      }),
    };

    await new PostgresAssistantTurnPersistence(
      database,
      60_000,
      conversationOwnershipRepository as never,
    ).completeAssistantTurn({
      workspaceId: "workspace_1",
      conversationId: "conv_1",
      assistantMessage: {
        id: "assistant_msg_1",
        conversationId: "conv_1",
        workspaceId: "workspace_1",
        role: "assistant",
        content: "A person will help you from here.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: "workspace_1",
        metadata: {},
      },
      ownershipHandoff: { reason: "routine_handoff", routineId: "routine_1", stepId: "handoff" },
      ownershipAuditEvent: {
        eventType: "hitl.ownership",
        eventStatus: "success",
        workspaceId: "workspace_1",
        metadata: {
          action: "handoff_requested",
          conversationId: "conv_1",
          routineId: "routine_1",
          stepId: "handoff",
        },
      },
    });

    expect(conversationOwnershipRepository.requestHandoff).toHaveBeenCalledWith(
      {
        conversationId: "conv_1",
        workspaceId: "workspace_1",
        reason: "routine_handoff",
      },
      expect.objectContaining({ queryOptional: expect.any(Function) }),
    );
    expect(handoffCallWasInsideTransaction.value).toBe(true);
    expect(calls.some(([sql]) => sql === "SELECT 1")).toBe(true);
    const auditCalls = calls.filter(([sql]) => sql.includes("INSERT INTO audit_events"));
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[1]![1]?.[3]).toBe("hitl.ownership");
  });
});
