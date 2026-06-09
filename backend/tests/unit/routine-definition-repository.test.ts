import { describe, expect, it, vi } from "vitest";

import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { Database } from "../../src/shared/infra/database.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";

const mockDatabase = () => {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
  const db = {
    query: vi.fn().mockResolvedValue([]),
    queryOptional: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue(1),
    withTransaction: vi.fn(async (cb: (client: typeof mockClient) => Promise<unknown>) => cb(mockClient)),
    mockClient,
  };
  return db as unknown as Database & typeof db;
};

const draftInput = () => ({
  name: "handoff",
  activation: {
    triggerDescription: "The user asks for a handoff.",
    gateRef: null,
    priority: 5,
  },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text" as const, required: true, description: "Visitor name.", ordinal: 0 },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat" as const, instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "done", guardKind: "llm" as const, guardText: "The user provided {{slot.name}}.", ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete" as const, instruction: "Confirm completion.", actionType: null, ordinal: 0 },
  ],
});

const loadedRow = () => ({
  id: "def_1",
  agent_id: "agent_1",
  name: "handoff",
  version: 1,
  status: "published",
  activation_trigger_description: "The user asks for a handoff.",
  activation_gate_ref: null,
  activation_priority: 5,
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "Visitor name.", ordinal: 0 },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "done", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", actionType: null, ordinal: 0 },
  ],
  created_at: new Date("2026-06-09T00:00:00.000Z"),
  updated_at: new Date("2026-06-09T00:00:00.000Z"),
});

describe("RoutineDefinitionRepository", () => {
  it("loads published definitions with one lateral json_agg per child set", async () => {
    const db = mockDatabase();
    db.query.mockResolvedValue([loadedRow()]);

    const definitions = await new RoutineDefinitionRepository(db).listPublishedByAgent("agent_1");

    expect(definitions[0]).toMatchObject<RoutineDefinition>({
      id: "def_1",
      agentId: "agent_1",
      name: "handoff",
      version: 1,
      status: "published",
      activation: { triggerDescription: "The user asks for a handoff.", gateRef: null, priority: 5 },
      slots: [{ stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "Visitor name.", ordinal: 0 }],
      steps: [{ stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "ask_name", toRef: "done", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm completion.", actionType: null, ordinal: 0 }],
      createdAt: new Date("2026-06-09T00:00:00.000Z"),
      updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    });
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql.match(/json_agg/g)?.length).toBe(4);
    expect(sql).toContain("routine_slot");
    expect(sql).toContain("routine_step");
    expect(sql).toContain("routine_transition");
    expect(sql).toContain("routine_terminal");
    expect(params).toEqual(["agent_1"]);
  });

  it("creates a draft parent plus child rows", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(loadedRow());

    await new RoutineDefinitionRepository(db).createDraft("agent_1", draftInput());

    expect(db.withTransaction).toHaveBeenCalledOnce();
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("INSERT INTO routine_definition");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("INSERT INTO routine_slot");
    expect(sql).toContain("INSERT INTO routine_step");
    expect(sql).toContain("INSERT INTO routine_transition");
    expect(sql).toContain("INSERT INTO routine_terminal");
    expect(db.queryOptional).toHaveBeenCalledOnce();
  });

  it("updates a draft and replaces child rows in routine tables only", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(loadedRow());

    await new RoutineDefinitionRepository(db).updateDraft("agent_1", "def_1", draftInput());

    expect(db.withTransaction).toHaveBeenCalledOnce();
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("UPDATE routine_definition");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("DELETE FROM routine_slot");
    expect(sql).toContain("DELETE FROM routine_step");
    expect(sql).toContain("DELETE FROM routine_transition");
    expect(sql).toContain("DELETE FROM routine_terminal");
    expect(sql).not.toContain("agent_directives");
    expect(sql).not.toContain("routine_states");
  });

  it("publishes by snapshotting the draft as the next version", async () => {
    const db = mockDatabase();
    db.queryOptional
      .mockResolvedValueOnce(loadedRow())
      .mockResolvedValueOnce({ ...loadedRow(), id: "def_2", version: 2, status: "published" });
    db.mockClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version: 2 }] });

    const published = await new RoutineDefinitionRepository(db).publish("agent_1", "def_1");

    expect(published.version).toBe(2);
    expect(published.status).toBe("published");
    expect(db.withTransaction).toHaveBeenCalledOnce();
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("pg_advisory_xact_lock");
    expect(db.mockClient.query.mock.calls[1]![0]).toContain("COALESCE(MAX(version), 0) + 1");
    expect(db.mockClient.query.mock.calls[2]![0]).toContain("INSERT INTO routine_definition");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("INSERT INTO routine_slot");
    expect(db.queryOptional).toHaveBeenCalledTimes(2);
  });
});
