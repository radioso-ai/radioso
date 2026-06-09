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
});
