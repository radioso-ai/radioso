import { describe, expect, it, vi } from "vitest";

import type { PendingClarification } from "@radioso/conversation-contract";

import { ClarificationStateRepository } from "../../src/db/repositories/clarificationStateRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

const pending = (overrides: Partial<PendingClarification> = {}): PendingClarification => ({
  sessionId: "11111111-1111-1111-1111-111111111111",
  source: "test_surface",
  originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
  mode: "ask",
  candidates: [
    { id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } },
    { id: "b", label: "Beta", confidence: 0.78, payload: { opaque: "b" } },
  ],
  askedEventId: "assistant_msg_1",
  status: "pending",
  expiresAt: new Date("2099-06-10T12:30:00.000Z"),
  ...overrides,
});

const row = (state: PendingClarification) => ({
  session_id: state.sessionId,
  source: state.source,
  original_query: state.originalQuery ?? null,
  mode: state.mode ?? "ask",
  candidates: state.candidates,
  asked_event_id: state.askedEventId ?? null,
  status: state.status,
  expires_at: state.expiresAt instanceof Date ? state.expiresAt : new Date(state.expiresAt),
});

const mockDatabase = () => {
  const db = {
    queryOptional: vi.fn(),
    execute: vi.fn().mockResolvedValue(1),
    query: vi.fn(),
    queryOne: vi.fn(),
  };
  return db as unknown as Database & typeof db;
};

describe("ClarificationStateRepository", () => {
  it("saves and loads a non-expired pending clarification", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(row(pending()));
    const repository = new ClarificationStateRepository(db, 30 * 60 * 1000);

    await repository.save(pending());
    const loaded = await repository.loadPending({ sessionId: pending().sessionId });

    expect(loaded).toEqual({
      ...pending(),
      expiresAt: new Date("2099-06-10T12:30:00.000Z"),
    });
    const [saveSql, saveParams] = db.execute.mock.calls[0]!;
    expect(saveSql).toContain("ON CONFLICT (session_id) DO UPDATE");
    expect(saveParams![0]).toBe(pending().sessionId);
    expect(saveParams![2]).toBe("How do I upload a document via the REST API? Give me a curl example.");
    expect(saveParams![3]).toBe("ask");
    expect(saveParams![4]).toBe(JSON.stringify(pending().candidates));
    const [loadSql] = db.queryOptional.mock.calls[0]!;
    expect(loadSql).toContain("status = 'pending'");
  });

  it("upserts a single pending row per session", async () => {
    const db = mockDatabase();
    const repository = new ClarificationStateRepository(db);

    await repository.save(pending({ source: "first" }));
    await repository.save(pending({ source: "second" }));

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.execute.mock.calls[1]![0]).toContain("ON CONFLICT (session_id) DO UPDATE");
    expect(db.execute.mock.calls[1]![1]![1]).toBe("second");
  });

  it("marks expired pending rows expired and returns null", async () => {
    const db = mockDatabase();
    const expired = pending({ expiresAt: new Date("2026-06-10T11:00:00.000Z") });
    db.queryOptional.mockResolvedValue(row(expired));
    const repository = new ClarificationStateRepository(db);

    await expect(repository.loadPending({ sessionId: expired.sessionId })).resolves.toBeNull();

    const [expireSql, expireParams] = db.execute.mock.calls[0]!;
    expect(expireSql).toContain("status = 'expired'");
    expect(expireSql).toContain("original_query = NULL");
    expect(expireParams).toEqual([expired.sessionId]);
  });

  it.each(["resolved", "declined", "expired"] as const)("clears %s pending state as a non-pending loop-guard row and nulls the original query", async (outcome) => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(row(pending({ status: outcome, originalQuery: undefined })));
    const repository = new ClarificationStateRepository(db);

    await repository.clear({ sessionId: pending().sessionId, outcome });
    const loaded = await repository.loadRecent({ sessionId: pending().sessionId });

    const [clearSql, clearParams] = db.execute.mock.calls[0]!;
    expect(clearSql).toContain("status = $2");
    expect(clearSql).toContain("original_query = NULL");
    expect(clearParams).toEqual([pending().sessionId, outcome]);
    expect(loaded?.status).toBe(outcome);
    expect(loaded?.originalQuery).toBeUndefined();
    expect(loaded?.candidates.map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });
});
