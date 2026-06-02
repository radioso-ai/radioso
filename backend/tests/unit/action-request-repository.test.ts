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

  it("claims the oldest pending requests for dispatch", async () => {
    const db = mockDatabase();
    db.query.mockResolvedValue([
      { id: "r1", type: "contact.send", payload: { a: 1 }, workspace_id: "ws", account_id: null, conversation_id: "c", idempotency_key: "k", status: "pending", attempts: 0 },
    ]);

    const claimed = await new ActionRequestRepository(db).claimPending(10);

    expect(claimed).toEqual([
      { id: "r1", type: "contact.send", payload: { a: 1 }, workspaceId: "ws", accountId: null, conversationId: "c", idempotencyKey: "k", status: "pending", attempts: 0 },
    ]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("ORDER BY created_at ASC");
    expect(params).toEqual([10]);
  });

  it("marks a request dispatched and a request failed (incrementing attempts)", async () => {
    const db = mockDatabase();
    const repo = new ActionRequestRepository(db);
    await repo.markDispatched("r1");
    await repo.markFailed("r2", "boom");
    expect(db.execute.mock.calls[0]![0]).toContain("status = 'dispatched'");
    expect(db.execute.mock.calls[1]![0]).toContain("attempts = attempts + 1");
    expect(db.execute.mock.calls[1]![1]).toEqual(["r2", "boom"]);
  });
});
