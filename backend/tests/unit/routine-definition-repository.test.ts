import { describe, expect, it, vi } from "vitest";

import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { Database } from "../../src/shared/infra/database.js";
import type {
  RoutineDefinition,
  RoutineDefinitionDraftInput,
} from "../../src/modules/routines/public.js";

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

const draftInput = (): RoutineDefinitionDraftInput => ({
  name: "handoff",
  activation: {
    triggerDescription: "The user asks for a handoff.",
    gateRef: null,
    priority: 5,
    reentryMode: "always",
  },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text" as const, required: true, description: "Visitor name.", ordinal: 0, mutable: true },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat" as const, instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "done", guardKind: "counter" as const, guardText: "2", ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete" as const, instruction: "Confirm completion.", ordinal: 0 },
  ],
  completionExport: {
    enabled: true,
    triggerKinds: ["complete"],
    destinationRef: "33333333-3333-4333-8333-333333333333",
  },
});

const loadedRow = () => ({
  id: "def_1",
  agent_id: "agent_1",
  lineage_id: "lineage_1",
  name: "handoff",
  version: 1,
  status: "published",
  activation_trigger_description: "The user asks for a handoff.",
  activation_gate_ref: null,
  activation_priority: 5,
  activation_reentry_mode: "always",
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "Visitor name.", ordinal: 0, mutable: true },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "done", guardKind: "counter", guardText: "2", ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 },
  ],
  completion_export: {
    enabled: true,
    triggerKinds: ["complete"],
    destinationRef: "33333333-3333-4333-8333-333333333333",
  },
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
      lineageId: "lineage_1",
      name: "handoff",
      version: 1,
      status: "published",
      activation: { triggerDescription: "The user asks for a handoff.", gateRef: null, priority: 5, reentryMode: "always" },
      slots: [{ stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "Visitor name.", ordinal: 0, mutable: true }],
      steps: [{ stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "ask_name", toRef: "done", guardKind: "counter", guardText: "2", ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 }],
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: "33333333-3333-4333-8333-333333333333",
      },
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
    expect(sql).toContain("routine_completion_export");
    expect(params).toEqual(["agent_1"]);
  });

  it("creates a draft parent plus child rows", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(loadedRow());

    await new RoutineDefinitionRepository(db).createDraft("agent_1", draftInput());

    expect(db.withTransaction).toHaveBeenCalledOnce();
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("INSERT INTO routine_definition");
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("activation_reentry_mode");
    expect(db.mockClient.query.mock.calls[0]![1]).toContain("always");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("INSERT INTO routine_slot");
    expect(sql).toContain("mutable");
    expect(sql).toContain("INSERT INTO routine_step");
    expect(sql).toContain("INSERT INTO routine_transition");
    expect(sql).toContain("INSERT INTO routine_terminal");
    expect(sql).toContain("INSERT INTO routine_completion_export");
    expect(db.queryOptional).toHaveBeenCalledOnce();
  });

  it("updates a draft and replaces child rows in routine tables only", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(loadedRow());
    db.mockClient.query.mockResolvedValueOnce({ rows: [{ id: "def_1" }] });

    await new RoutineDefinitionRepository(db).updateDraft("agent_1", "def_1", draftInput());

    expect(db.withTransaction).toHaveBeenCalledOnce();
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("UPDATE routine_definition");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("DELETE FROM routine_slot");
    expect(sql).toContain("DELETE FROM routine_step");
    expect(sql).toContain("DELETE FROM routine_transition");
    expect(sql).toContain("DELETE FROM routine_terminal");
    expect(sql).toContain("DELETE FROM routine_completion_export");
    expect(sql).not.toContain("agent_directives");
    expect(sql).not.toContain("routine_states");
  });

  it("aborts a draft update that matched no draft row before touching children", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValue(loadedRow());
    // Default mock returns zero rows: the draft row was already flipped to
    // published by a racing publish.
    await expect(new RoutineDefinitionRepository(db).updateDraft("agent_1", "def_1", draftInput()))
      .rejects.toThrow("routine_definition_update_conflict:def_1");

    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).not.toContain("DELETE FROM routine_step");
  });

  it("publishes by superseding the prior published row and updating the draft in place", async () => {
    const db = mockDatabase();
    db.queryOptional
      .mockResolvedValueOnce({ ...loadedRow(), status: "draft" })
      .mockResolvedValueOnce({ ...loadedRow(), id: "def_1", version: 1, status: "published" });
    db.mockClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "published_1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "def_1" }] });

    const published = await new RoutineDefinitionRepository(db).publish("agent_1", "def_1");

    expect(published.id).toBe("def_1");
    expect(published.version).toBe(1);
    expect(published.status).toBe("published");
    expect(db.withTransaction).toHaveBeenCalledOnce();
    expect(db.mockClient.query.mock.calls[0]![0]).toContain("pg_advisory_xact_lock");
    expect(db.mockClient.query.mock.calls[0]![1]).toEqual(["routine_definition_publish:lineage_1"]);
    expect(db.mockClient.query.mock.calls[1]![0]).toContain("status = 'superseded'");
    expect(db.mockClient.query.mock.calls[2]![0]).toContain("status = 'published'");
    expect(db.mockClient.query.mock.calls[2]![0]).toContain("status = 'draft'");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).not.toContain("INSERT INTO routine_definition");
    expect(sql).not.toContain("DELETE FROM routine_definition");
    expect(sql).not.toContain("INSERT INTO routine_slot");
    expect(db.queryOptional).toHaveBeenCalledTimes(2);
  });

  it("creates a revision draft in the same lineage by copying children and completion export", async () => {
    const db = mockDatabase();
    db.queryOptional
      .mockResolvedValueOnce({ ...loadedRow(), id: "published_1", status: "published", lineage_id: "lineage_1" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...loadedRow(), id: "draft_2", status: "draft", version: 1, lineage_id: "lineage_1" });

    const draft = await new RoutineDefinitionRepository(db).createRevisionDraft("agent_1", "published_1");

    if (!draft) {
      throw new Error("expected revision draft");
    }
    expect(draft.id).toBe("draft_2");
    expect(draft.status).toBe("draft");
    expect(draft.lineageId).toBe("lineage_1");
    const sql = db.mockClient.query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("lineage_id");
    expect(sql).toContain("INSERT INTO routine_definition");
    expect(sql).toContain("INSERT INTO routine_slot");
    expect(sql).toContain("INSERT INTO routine_step");
    expect(sql).toContain("INSERT INTO routine_transition");
    expect(sql).toContain("INSERT INTO routine_terminal");
    expect(sql).toContain("INSERT INTO routine_completion_export");
  });

  it("returns the existing lineage draft instead of creating a second revision draft", async () => {
    const db = mockDatabase();
    db.queryOptional
      .mockResolvedValueOnce({ ...loadedRow(), id: "published_1", status: "published", lineage_id: "lineage_1" })
      .mockResolvedValueOnce({ ...loadedRow(), id: "draft_1", status: "draft", lineage_id: "lineage_1" });

    const draft = await new RoutineDefinitionRepository(db).createRevisionDraft("agent_1", "published_1");

    if (!draft) {
      throw new Error("expected existing revision draft");
    }
    expect(draft.id).toBe("draft_1");
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("returns the raced-in lineage draft when revision creation hits the one-draft index", async () => {
    const db = mockDatabase();
    db.queryOptional
      .mockResolvedValueOnce({ ...loadedRow(), id: "published_1", status: "published", lineage_id: "lineage_1" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...loadedRow(), id: "draft_race", status: "draft", lineage_id: "lineage_1" });
    db.withTransaction.mockRejectedValueOnce(Object.assign(new Error("duplicate draft"), { code: "23505" }));

    const draft = await new RoutineDefinitionRepository(db).createRevisionDraft("agent_1", "published_1");

    if (!draft) {
      throw new Error("expected raced revision draft");
    }
    expect(draft.id).toBe("draft_race");
    expect(db.queryOptional).toHaveBeenCalledTimes(3);
  });

  it("archives only published definitions and restores only when the lineage has no published version", async () => {
    const db = mockDatabase();
    db.queryOptional.mockResolvedValueOnce({ ...loadedRow(), id: "published_1", status: "archived", lineage_id: "lineage_1" });
    db.mockClient.query.mockResolvedValueOnce({ rows: [{ id: "published_1" }] });

    const repository = new RoutineDefinitionRepository(db);
    await expect(repository.archive("agent_1", "published_1")).resolves.toBe(true);
    await expect(repository.restore("agent_1", "published_1")).resolves.toBe(true);

    const archiveSql = db.queryOptional.mock.calls[0]![0];
    expect(archiveSql).toContain("status = 'archived'");
    expect(archiveSql).toContain("status = 'published'");
    const restoreSql = db.mockClient.query.mock.calls[0]![0];
    expect(restoreSql).toContain("status = 'published'");
    expect(restoreSql).toContain("status = 'archived'");
    expect(restoreSql).toContain("NOT EXISTS");
    expect(db.mockClient.query.mock.calls[1]![0]).toContain("UPDATE routine_completion_export");
  });

  it("lists published routines referencing a webhook destination in a workspace", async () => {
    const db = mockDatabase();
    db.query.mockResolvedValue([{ name: "lead intake" }, { name: "support handoff" }]);

    const names = await new RoutineDefinitionRepository(db)
      .listPublishedRoutineNamesReferencingDestination("workspace_1", "dest_1");

    expect(names).toEqual(["lead intake", "support handoff"]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("routine_completion_export");
    expect(sql).toContain("agents");
    expect(sql).toContain("d.status = 'published'");
    expect(params).toEqual(["workspace_1", "dest_1"]);
  });
});
