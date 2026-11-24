import { describe, expect, it, vi } from "vitest";

import {
  ContextValueSaves,
  type ContextValueSaveStore,
  type SaveTargetDefinition,
} from "../../src/modules/context-variables/contextValueSaves.js";
import { CONTEXT_VALUE_WRITES_TOTAL } from "../../src/modules/context-variables/conversationValueWriter.js";
import { conversationSaveScope } from "../../src/modules/context-variables/domain.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";

const trx = {} as Db;
const conversation = { id: "00000000-0000-4000-8000-000000000001", verifiedCustomerId: null as string | null };
const writtenBy = { kind: "routine" as const, ref: "routine-1:execution-1" };

const definition = (name: string, overrides: Partial<SaveTargetDefinition> = {}): SaveTargetDefinition => ({
  id: `variable-${name}`,
  workspaceId: "workspace-1",
  name,
  valueType: "number",
  options: null,
  trustTier: "unverified",
  sensitivity: "normal",
  ...overrides,
});

const harness = (definitions: SaveTargetDefinition[], stored: "written" | "unchanged" | "kept" = "written") => {
  const store: ContextValueSaveStore = {
    lockDefinitionNamedIn: vi.fn(async (_trx, _workspaceId, name: string) => definitions.find((candidate) => candidate.name === name) ?? null),
    storeIn: vi.fn(async () => stored),
  };
  const incrementCounter = vi.fn();
  const saves = new ContextValueSaves({ store, metrics: { incrementCounter } });
  return { store, saves, incrementCounter };
};

const save = (variableName: string, data: unknown, overrides: Partial<{ scope: "conversation" | "person"; sensitive: boolean }> = {}) => ({
  variableName,
  data,
  scope: "conversation" as const,
  sensitive: false,
  ...overrides,
});

describe("conversationSaveScope", () => {
  it("keeps a conversation save on the conversation and a person save on the verified customer", () => {
    expect(conversationSaveScope("conversation", { conversationId: "c-1", verifiedCustomerId: "cust-1" })).toEqual({ type: "conversation", id: "c-1" });
    expect(conversationSaveScope("person", { conversationId: "c-1", verifiedCustomerId: "cust-1" })).toEqual({ type: "customer", id: "cust-1" });
  });

  it("has no scope for the person of a conversation with no verified person, and no other stands in", () => {
    expect(conversationSaveScope("person", { conversationId: "c-1", verifiedCustomerId: null })).toBeNull();
  });
});

describe("ContextValueSaves", () => {
  it("stores each value in the caller's transaction, naming the routine, and counts it", async () => {
    const { saves, store, incrementCounter } = harness([definition("party_size")]);

    const outcomes = await saves.saveAll(trx, { workspaceId: "workspace-1", conversation, writtenBy, routineId: "routine-1", saves: [save("party_size", 4)] });

    expect(outcomes).toEqual(["written"]);
    expect(store.storeIn).toHaveBeenCalledWith(trx, {
      definition: definition("party_size"),
      scope: { type: "conversation", id: conversation.id },
      data: 4,
      writtenBy,
      routineId: "routine-1",
    });
    expect(incrementCounter).toHaveBeenCalledWith(CONTEXT_VALUE_WRITES_TOTAL, expect.objectContaining({ labels: { writer: "routine", outcome: "written" } }));
  });

  it("writes nothing for the person of a conversation with no verified person, and says so", async () => {
    const { saves, store, incrementCounter } = harness([definition("party_size")]);

    const outcomes = await saves.saveAll(trx, { workspaceId: "workspace-1", conversation, writtenBy, routineId: "routine-1", saves: [save("party_size", 4, { scope: "person" })] });

    expect(outcomes).toEqual(["no_person_key"]);
    expect(store.storeIn).not.toHaveBeenCalled();
    expect(incrementCounter).toHaveBeenCalledWith(CONTEXT_VALUE_WRITES_TOTAL, expect.objectContaining({ labels: { writer: "routine", outcome: "no_person_key" } }));
  });

  it("refuses, against the attribute as it is now, a value of another type, proof, and a sensitive value into a non-Private attribute", async () => {
    const { saves, store } = harness([
      definition("party_size"),
      definition("plan", { valueType: "string", trustTier: "signed" }),
      definition("guest_note", { valueType: "string" }),
    ]);

    const outcomes = await saves.saveAll(trx, {
      workspaceId: "workspace-1",
      conversation,
      writtenBy,
      routineId: "routine-1",
      saves: [save("party_size", "four"), save("plan", "gold"), save("guest_note", "sprained ankle", { sensitive: true }), save("deleted", 1)],
    });

    expect(outcomes).toEqual(["refused_type", "refused_trust", "refused_sensitive", "gone"]);
    expect(store.storeIn).not.toHaveBeenCalled();
  });

  it("reports an unchanged value as the store does", async () => {
    const { saves } = harness([definition("party_size")], "unchanged");

    expect(await saves.saveAll(trx, { workspaceId: "workspace-1", conversation, writtenBy, routineId: "routine-1", saves: [save("party_size", 4)] }))
      .toEqual(["unchanged"]);
  });

  it("counts a failed write and lets it fail the caller's transaction", async () => {
    const { saves, store, incrementCounter } = harness([definition("party_size")]);
    vi.mocked(store.storeIn).mockRejectedValueOnce(new Error("connection reset"));

    await expect(saves.saveAll(trx, { workspaceId: "workspace-1", conversation, writtenBy, routineId: "routine-1", saves: [save("party_size", 4)] }))
      .rejects.toThrow("connection reset");
    expect(incrementCounter).toHaveBeenCalledWith(CONTEXT_VALUE_WRITES_TOTAL, expect.objectContaining({ labels: { writer: "routine", outcome: "failed" } }));
  });
});
