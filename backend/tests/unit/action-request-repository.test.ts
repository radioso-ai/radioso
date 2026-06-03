import { describe, expect, it, vi } from "vitest";

import { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

const mockDatabase = () => {
  const db = {
    queryOptional: vi.fn(),
    queryOne: vi.fn(),
    query: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue(1),
  };
  return db as unknown as Database & typeof db;
};

describe("ActionRequestRepository", () => {
  it("enqueues a new request and returns its id (not a duplicate)", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue({ id: "req_1" });

    const result = await new ActionRequestRepository(db).enqueue({
      type: "contact.send",
      payload: { email: "x@y.z" },
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: "k1",
    });

    expect(result).toEqual({ id: "req_1", duplicate: false });
    const [sql, params] = db.queryOptional.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (idempotency_key)");
    expect(params![0]).toBe("contact.send");
    expect(params![1]).toBe(JSON.stringify({ email: "x@y.z" }));
    expect(params![5]).toBe("k1");
  });

  it("returns the existing row id when the idempotency key already exists (idempotent enqueue)", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(null); // ON CONFLICT DO NOTHING → no insert
    db.queryOne.mockResolvedValue({ id: "req_existing" });

    const result = await new ActionRequestRepository(db).enqueue({
      type: "contact.send",
      payload: {},
      idempotencyKey: "k1",
    });

    expect(result).toEqual({ id: "req_existing", duplicate: true });
    expect(db.queryOne.mock.calls[0]![1]).toEqual(["k1"]);
  });

  it("atomically claims due requests (in_progress, attempts++, lease + SKIP LOCKED)", async () => {
    const db = mockDatabase();
    db.query.mockResolvedValue([
      { id: "r1", type: "contact.send", payload: { a: 1 }, workspace_id: "ws", account_id: null, conversation_id: "c", idempotency_key: "k", status: "in_progress", attempts: 1 },
    ]);

    const claimed = await new ActionRequestRepository(db).claimPending(10, 300);

    expect(claimed).toEqual([
      { id: "r1", type: "contact.send", payload: { a: 1 }, workspaceId: "ws", accountId: null, conversationId: "c", idempotencyKey: "k", status: "in_progress", attempts: 1 },
    ]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("UPDATE routine_action_requests");
    expect(sql).toContain("SET status = 'in_progress', attempts = attempts + 1");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'in_progress' AND updated_at < now() - make_interval(secs => $2)");
    expect(params).toEqual([10, 300]);
  });

  it("marks dispatched only this exact claim (guarded on attempts + in_progress)", async () => {
    const db = mockDatabase();
    await new ActionRequestRepository(db).markDispatched("r1", 2);
    expect(db.execute.mock.calls[0]![0]).toContain("status = 'dispatched'");
    expect(db.execute.mock.calls[0]![0]).toContain("id = $1 AND attempts = $2 AND status = 'in_progress'");
    expect(db.execute.mock.calls[0]![1]).toEqual(["r1", 2]);
  });

  it("retries within budget, fails terminally when spent, and supersedes a reclaimed row", async () => {
    const db = mockDatabase();
    const repo = new ActionRequestRepository(db);

    db.queryOptional.mockResolvedValueOnce({ status: "pending" });
    expect(await repo.recordFailure("r1", "smtp down", 1, 5, 60)).toBe("retry");

    db.queryOptional.mockResolvedValueOnce({ status: "failed" });
    expect(await repo.recordFailure("r2", "smtp down", 5, 5, 60)).toBe("failed");

    // No row matched the (id, attempt) guard → another worker reclaimed it.
    db.queryOptional.mockResolvedValueOnce(null);
    expect(await repo.recordFailure("r3", "smtp down", 1, 5, 60)).toBe("superseded");

    const [sql, params] = db.queryOptional.mock.calls[0]!;
    expect(sql).toContain("WHEN attempts >= $4 THEN 'failed' ELSE 'pending'");
    expect(sql).toContain("now() + make_interval(secs => $5)");
    expect(sql).toContain("WHERE id = $1 AND attempts = $3 AND status = 'in_progress'");
    expect(params).toEqual(["r1", "smtp down", 1, 5, 60]);
  });
});
