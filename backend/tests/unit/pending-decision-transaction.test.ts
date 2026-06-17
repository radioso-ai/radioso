import { describe, expect, it, vi } from "vitest";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { PendingDecisionRepository } from "../../src/db/repositories/pendingDecisionRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

const queryResult = <T extends QueryResultRow>(rows: T[]): QueryResult<T> => ({
  rows,
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
});

describe("PendingDecisionRepository transaction helper", () => {
  it("runs the pending-decision CAS and caller resume work on the same transaction executor", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE pending_decisions")) {
        return queryResult([{
          id: "decision_row_1",
          handle: "pd_1",
          conversation_id: "conv_1",
          session_id: "session_1",
          workspace_id: "workspace_1",
          agent_id: "agent_1",
          routine_id: "routine_1",
          step_id: "gate",
          reason: null,
          options: [{ id: "approve", label: "Approve" }],
          decider_scope: { kind: "workspace_member" },
          content_hash: "hash_1",
          status: "approved",
          decision: { optionId: "approve" },
          decided_by: null,
          decided_at: new Date("2026-06-17T00:00:00.000Z"),
          deadline: null,
          created_at: new Date("2026-06-17T00:00:00.000Z"),
          updated_at: new Date("2026-06-17T00:00:00.000Z"),
        }]);
      }
      if (sql.includes("SELECT session_id FROM routine_states")) {
        return queryResult([{ session_id: "session_1" }]);
      }
      return queryResult([]);
    });
    const client = { query };
    const database = {
      withTransaction: vi.fn(async (callback: (transactionClient: PoolClient) => Promise<unknown>) =>
        callback(client as unknown as PoolClient)
      ),
    } as unknown as Database;
    const repository = new PendingDecisionRepository(database);

    const result = await repository.resolveInTransaction({
      handle: "pd_1",
      outcome: "approved",
      decision: { optionId: "approve" },
      decidedBy: null,
      contentHash: "hash_1",
    }, async (record, executor) => {
      const suspended = await executor.queryOne<{ session_id: string }>(
        "SELECT session_id FROM routine_states WHERE session_id = $1",
        [record.sessionId],
      );
      return suspended.session_id;
    });

    expect(result).toBe("session_1");
    expect(database.withTransaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE pending_decisions"), expect.any(Array));
    expect(query).toHaveBeenCalledWith(
      "SELECT session_id FROM routine_states WHERE session_id = $1",
      ["session_1"],
    );
  });

  it("skips caller resume work when the CAS does not resolve a pending row", async () => {
    const query = vi.fn(async () => queryResult([]));
    const database = {
      withTransaction: vi.fn(async (callback: (transactionClient: PoolClient) => Promise<unknown>) =>
        callback({ query } as unknown as PoolClient)
      ),
    } as unknown as Database;
    const repository = new PendingDecisionRepository(database);
    const onResolved = vi.fn(async () => "should_not_run");

    const result = await repository.resolveInTransaction({
      handle: "pd_1",
      outcome: "approved",
      decision: { optionId: "approve" },
      decidedBy: null,
      contentHash: "stale",
    }, onResolved);

    expect(result).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
  });
});
