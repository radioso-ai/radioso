import { describe, expect, it, vi } from "vitest";

import {
  CONTEXT_VALUE_WRITES_TOTAL,
  ConversationValueWriterService,
  planConversationWrite,
} from "../../src/modules/context-variables/conversationValueWriter.js";
import type { ContextValueWriter, ContextVariable } from "../../src/modules/context-variables/domain.js";

const conversationId = "00000000-0000-4000-8000-000000000004";
const classifier: ContextValueWriter = { kind: "classifier", ref: "context-classification/1" };

const topic = (overrides: Partial<ContextVariable> = {}): ContextVariable => ({
  id: "variable-1",
  workspaceId: "workspace-1",
  name: "topic",
  description: null,
  valueType: "enum",
  options: [
    { key: "billing", label: "Billing", description: null, archived: false },
    { key: "shipping", label: "Shipping", description: null, archived: false },
    { key: "legacy", label: "Legacy", description: null, archived: true },
  ],
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const stored = (data: unknown, kind: ContextValueWriter["kind"]) => ({ data, writtenBy: { kind, ref: null } });

describe("planConversationWrite", () => {
  it("fills an empty value and replaces the classifier's own", () => {
    expect(planConversationWrite({ variable: topic(), stored: null, data: "billing", writer: "classifier" })).toEqual({ action: "store", outcome: "written" });
    expect(planConversationWrite({ variable: topic(), stored: stored("shipping", "classifier"), data: "billing", writer: "classifier" })).toEqual({ action: "store", outcome: "written" });
  });

  it.each(["api", "operator", "routine"] as const)("keeps a value the %s wrote", (kind) => {
    expect(planConversationWrite({ variable: topic(), stored: stored("shipping", kind), data: "billing", writer: "classifier" })).toEqual({ action: "none", outcome: "kept" });
    expect(planConversationWrite({ variable: topic(), stored: stored("shipping", kind), data: null, writer: "classifier" })).toEqual({ action: "none", outcome: "kept" });
  });

  it("writes nothing when the result is unchanged, and clears only the classifier's own value on null", () => {
    expect(planConversationWrite({ variable: topic(), stored: stored("billing", "classifier"), data: "billing", writer: "classifier" })).toEqual({ action: "none", outcome: "unchanged" });
    expect(planConversationWrite({ variable: topic(), stored: null, data: null, writer: "classifier" })).toEqual({ action: "none", outcome: "unchanged" });
    expect(planConversationWrite({ variable: topic(), stored: stored("billing", "classifier"), data: null, writer: "classifier" })).toEqual({ action: "clear", outcome: "cleared" });
  });

  it("refuses a key that is not an active option, and a variable the classifier may not fill", () => {
    expect(planConversationWrite({ variable: topic(), stored: null, data: "legacy", writer: "classifier" }).outcome).toBe("refused_type");
    expect(planConversationWrite({ variable: topic(), stored: null, data: "unknown", writer: "classifier" }).outcome).toBe("refused_type");
    expect(planConversationWrite({ variable: topic({ valueType: "string", options: null }), stored: null, data: "billing", writer: "classifier" }).outcome).toBe("refused_type");
    expect(planConversationWrite({ variable: topic({ trustTier: "signed" }), stored: null, data: "billing", writer: "classifier" }).outcome).toBe("refused_trust");
    expect(planConversationWrite({ variable: topic({ sensitivity: "sensitive" }), stored: null, data: "billing", writer: "classifier" }).outcome).toBe("refused_sensitive");
  });
});

describe("ConversationValueWriterService", () => {
  const writerWith = (repository: { upsertValue?: ReturnType<typeof vi.fn>; deleteValueWrittenBy?: ReturnType<typeof vi.fn> }) => {
    const metrics = { incrementCounter: vi.fn() };
    const deps = {
      upsertValue: repository.upsertValue ?? vi.fn(async () => ({ id: "value-1" })),
      deleteValueWrittenBy: repository.deleteValueWrittenBy ?? vi.fn(async () => true),
    };
    return { writer: new ConversationValueWriterService({ repository: deps as never, metrics }), deps, metrics };
  };

  it("stores under the conversation with the writer's provenance and counts the write", async () => {
    const { writer, deps, metrics } = writerWith({});

    await expect(writer.write({ conversationId, variable: topic(), stored: null, data: "billing", writtenBy: classifier })).resolves.toBe("written");

    expect(deps.upsertValue).toHaveBeenCalledWith("variable-1", { type: "conversation", id: conversationId }, "billing", classifier);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(CONTEXT_VALUE_WRITES_TOTAL, expect.objectContaining({ labels: { writer: "classifier", outcome: "written" } }));
  });

  it("reports a value another writer stored while the run read as kept", async () => {
    const { writer } = writerWith({ upsertValue: vi.fn(async () => null), deleteValueWrittenBy: vi.fn(async () => false) });

    await expect(writer.write({ conversationId, variable: topic(), stored: null, data: "billing", writtenBy: classifier })).resolves.toBe("kept");
    await expect(writer.write({ conversationId, variable: topic(), stored: stored("billing", "classifier"), data: null, writtenBy: classifier })).resolves.toBe("kept");
  });

  it("clears only rows the writer may replace, and writes nothing for an unchanged value", async () => {
    const { writer, deps, metrics } = writerWith({});

    await expect(writer.write({ conversationId, variable: topic(), stored: stored("billing", "classifier"), data: null, writtenBy: classifier })).resolves.toBe("cleared");
    expect(deps.deleteValueWrittenBy).toHaveBeenCalledWith("variable-1", { type: "conversation", id: conversationId }, ["classifier"]);

    await expect(writer.write({ conversationId, variable: topic(), stored: stored("billing", "classifier"), data: "billing", writtenBy: classifier })).resolves.toBe("unchanged");
    expect(deps.upsertValue).not.toHaveBeenCalled();
    // A value is never a label: the counter carries the writer kind and the outcome only.
    for (const [, options] of metrics.incrementCounter.mock.calls) {
      expect(Object.keys((options as { labels: object }).labels).sort()).toEqual(["outcome", "writer"]);
    }
  });
});
