import { describe, expect, it, vi } from "vitest";

import type { RoutineState } from "@radioso/conversation-contract";

import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

const mockDatabase = () => {
  const db = {
    queryOptional: vi.fn(),
    execute: vi.fn().mockResolvedValue(1),
    query: vi.fn(),
    queryOne: vi.fn(),
  };
  return db as unknown as Database & typeof db;
};

describe("RoutineStateRepository", () => {
  it("loads only an active, non-expired routine and maps it to the contract record", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue({
      session_id: "conv_1",
      routine_id: "human_contact.request",
      path: ["ask_email"],
      variables: { email: "x@y.z" },
      status: "active",
      expires_at: null,
    });

    const state = await new RoutineStateRepository(db).loadActive({ sessionId: "conv_1" });

    expect(state).toEqual({
      sessionId: "conv_1",
      routineId: "human_contact.request",
      path: ["ask_email"],
      variables: { email: "x@y.z" },
      status: "active",
    });
    const [sql, params] = db.queryOptional.mock.calls[0]!;
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("expires_at > now()");
    expect(params).toEqual(["conv_1"]);
  });

  it("returns null when there is no active routine", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(null);
    expect(await new RoutineStateRepository(db).loadActive({ sessionId: "conv_1" })).toBeNull();
  });

  it("upserts on save with a fresh TTL, the path array, and serialized variables", async () => {
    const db = mockDatabase();
    const state: RoutineState = {
      sessionId: "conv_1",
      routineId: "human_contact.request",
      path: ["ask_email", "ask_message"],
      variables: { email: "x@y.z" },
      status: "active",
    };

    await new RoutineStateRepository(db, 60_000).save(state);

    const [sql, params] = db.execute.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (session_id) DO UPDATE");
    expect(params![0]).toBe("conv_1");
    expect(params![2]).toEqual(["ask_email", "ask_message"]);
    expect(params![3]).toBe(JSON.stringify({ email: "x@y.z" }));
    expect(params![4]).toBe("active");
  });

  it("clears by deleting the session's row", async () => {
    const db = mockDatabase();
    await new RoutineStateRepository(db).clear({ sessionId: "conv_1" });
    const [sql, params] = db.execute.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM routine_states");
    expect(params).toEqual(["conv_1"]);
  });
});
