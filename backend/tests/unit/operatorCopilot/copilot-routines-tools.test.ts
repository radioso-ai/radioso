import { describe, expect, it } from "vitest";

import { context, dependencies, routine } from "./copilot-tools-test-helpers.js";

describe("copilot routine readers", () => {
  it("lists routine identities and portability metadata without duplicating content", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as Record<string, unknown>;

    expect(ports.listRoutines).toHaveBeenCalledWith("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(ports.getRoutine).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      routineCount: 2,
      routinesTruncated: false,
      routine: null,
      routines: [
        { id: "11111111-1111-4111-8111-111111111111", name: "support-intake", status: "draft", portable: { ok: true, grammarVersion: 1 } },
        { id: "22222222-2222-4222-8222-222222222222", name: "book-a-demo", status: "draft", portable: { ok: true, grammarVersion: 1 } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Ask how we can help");
  });

  it("reads one routine with its stable identity and complete portable content", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ routineId: "11111111-1111-4111-8111-111111111111" }, {} as never);

    expect(result).toMatchObject({
      routine: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "support-intake",
        status: "draft",
        portable: { ok: true, grammarVersion: 1, omittedReason: null },
      },
      routines: [],
    });
    expect(JSON.stringify(result)).toContain("Ask how we can help");
    expect(ports.listRoutines).not.toHaveBeenCalled();
  });

  it("names the stable ids an edit addresses, which the portable prose does not carry", async () => {
    // The portable document is what a routine says, not what to call its parts. A reader that
    // describes a step perfectly and cannot name it leaves guessing the id as the only move.
    const ports = dependencies([routine({
      slots: [{ stableSlotId: "slot_order", key: "order_number", type: "text", required: true, description: "The order", ordinal: 0 }],
    })]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .invoke({ routineId: "11111111-1111-4111-8111-111111111111" }, {} as never) as { routine: { editable: unknown } };

    expect(result.routine.editable).toEqual({
      steps: [{ stableStepId: "collect_topic", kind: "chat", instruction: "Ask how we can help." }],
      endings: [{ stableStepId: "done", kind: "complete", instruction: null }],
      fields: [{ key: "order_number", type: "text", required: true, description: "The order" }],
    });
  });

  it("keeps the addressable list short when an element's wording is long", async () => {
    const ports = dependencies([routine({
      steps: [{ stableStepId: "collect_topic", kind: "chat", instruction: "x".repeat(400), toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    })]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .invoke({ routineId: "11111111-1111-4111-8111-111111111111" }, {} as never) as { routine: { editable: { steps: Array<{ instruction: string }> } } };

    expect(result.routine.editable.steps[0].instruction).toHaveLength(161);
  });

  it("reports nonportable routines without failing discovery or detail", async () => {
    const unsupported = routine({
      id: "44444444-4444-4444-8444-444444444444",
      name: "gated-routine",
      activation: { triggerDescription: "Gated", gateRef: "existing-gate", priority: 0, reentryMode: "always" },
    });
    const ports = dependencies([routine(), unsupported]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const listed = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never);
    const detailed = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ routineId: unsupported.id }, {} as never);

    expect(listed).toMatchObject({ routines: [{ portable: { ok: true } }, { id: unsupported.id, portable: { ok: false } }] });
    expect(detailed).toMatchObject({ routine: { id: unsupported.id, portable: { ok: false } } });
  });

  it("bounds routine discovery with explicit counts and truncation metadata", async () => {
    const routines = Array.from({ length: 41 }, (_, index) => routine({
      id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      name: `routine-${index}`,
    }));
    const ports = dependencies(routines);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as { routines: unknown[]; routineCount: number; routinesTruncated: boolean };

    expect(result.routines).toHaveLength(40);
    expect(result.routineCount).toBe(41);
    expect(result.routinesTruncated).toBe(true);
  });

  it("omits oversized routine content instead of returning corrupted markdown", async () => {
    const oversized = routine({
      steps: [{
        stableStepId: "collect_topic",
        kind: "chat",
        instruction: "x".repeat(20_001),
        toolRef: null,
        actionType: null,
        ordinal: 0,
        metadata: { outlineLabel: "collect_topic" },
      }],
    });
    const ports = dependencies([oversized]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ routineId: oversized.id }, {} as never);

    expect(result).toMatchObject({
      routine: { portable: { ok: true, content: null, omittedReason: "content_too_large" } },
    });
    // The addressable list still names the step, because an oversized routine is exactly one an
    // operator wants edited — but it carries a locator, not the wording.
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
    expect((result as { routine: { editable: { steps: Array<{ instruction: string }> } } }).routine.editable.steps[0].instruction).toHaveLength(161);
  });
});

describe("copilot routine validation", () => {
  it("reports what is wrong with a routine, not merely that something is", async () => {
    const ports = dependencies();
    ports.validateRoutine.mockResolvedValueOnce({
      ok: false,
      diagnostics: [{ code: "unreachable_step", location: "steps.confirm", message: "No transition reaches confirm." }],
    });
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "validate_routine")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .invoke({ routineId: "11111111-1111-4111-8111-111111111111" }, {} as never);

    expect(ports.validateRoutine).toHaveBeenCalledWith("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { id: "11111111-1111-4111-8111-111111111111" });
    expect(result).toEqual({
      routineId: "11111111-1111-4111-8111-111111111111",
      name: "support-intake",
      status: "draft",
      ok: false,
      diagnosticCount: 1,
      diagnosticsTruncated: false,
      diagnostics: [{ code: "unreachable_step", location: "steps.confirm", message: "No transition reaches confirm." }],
    });
  });

  it("bounds a flood of diagnostics instead of pasting the whole validator output into the turn", async () => {
    const ports = dependencies();
    ports.validateRoutine.mockResolvedValueOnce({
      ok: false,
      diagnostics: Array.from({ length: 45 }, (_, index) => ({ code: "dangling_step_reference", location: `steps.step_${index}`, message: "Missing." })),
    });
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "validate_routine")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .invoke({ routineId: "11111111-1111-4111-8111-111111111111" }, {} as never) as { diagnostics: unknown[]; diagnosticCount: number; diagnosticsTruncated: boolean };

    expect(result.diagnostics).toHaveLength(40);
    expect(result.diagnosticCount).toBe(45);
    expect(result.diagnosticsTruncated).toBe(true);
  });

  it("asks for a routine rather than validating an unnamed one", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "validate_routine")!;

    await expect(tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never)).rejects.toThrow(/routine/i);
    expect(ports.validateRoutine).not.toHaveBeenCalled();
  });

  it("stays a read: validating spends no model budget and may be retried", async () => {
    const tool = dependencies().descriptors.find((descriptor) => descriptor.name === "validate_routine")!;

    expect(tool.shape).toBe("read");
    expect(tool.requiredPermissions).toEqual(["workspace.agents.read"]);
  });
});

describe("copilot routine name resolution", () => {
  const lineage = "33333333-3333-4333-8333-333333333333";

  it("resolves a routine named across its own versions to the one that is running", async () => {
    // A lineage keeps every version it has had: publishing leaves the previous one superseded and
    // revising adds a draft beside the published row, all under one name. Reading that as an
    // ambiguity told an operator their own routine was ambiguous with itself.
    const ports = dependencies([
      routine({ id: "11111111-1111-4111-8111-111111111111", lineageId: lineage, version: 1, status: "superseded" }),
      routine({ id: "22222222-2222-4222-8222-222222222222", lineageId: lineage, version: 2, status: "published" }),
      routine({ id: "44444444-4444-4444-8444-444444444444", lineageId: lineage, version: 3, status: "draft" }),
    ]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    expect(await tool.describeEntity!({ routineTitle: "support-intake" }, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).toMatchObject({
      kind: "resolved",
      entity: { type: "routine", id: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("resolves the version each tool acts on: the draft to validate, the live one to read", async () => {
    const ports = dependencies([
      routine({ id: "22222222-2222-4222-8222-222222222222", lineageId: lineage, version: 2, status: "published" }),
      routine({ id: "44444444-4444-4444-8444-444444444444", lineageId: lineage, version: 3, status: "draft" }),
    ]);
    const byName = new Map(ports.descriptors.map((descriptor) => [descriptor.name, descriptor]));

    expect(await byName.get("routine_definition")!.describeEntity!({ routineTitle: "support-intake" }, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")))
      .toMatchObject({ entity: { id: "22222222-2222-4222-8222-222222222222" } });
    expect(await byName.get("validate_routine")!.describeEntity!({ routineTitle: "support-intake" }, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")))
      .toMatchObject({ entity: { id: "44444444-4444-4444-8444-444444444444" } });
  });

  it("resolves a named agent even when the routine is already addressed by id", async () => {
    // The routine lookup is scoped by agent, so leaving agentName unresolved would look the routine
    // up under whichever agent the page happens to be on.
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    expect(await tool.describeEntity!({ agentName: "Support", routineId: "11111111-1111-4111-8111-111111111111" }, context(null))).toMatchObject({
      kind: "resolved",
      entity: { type: "routine", id: "11111111-1111-4111-8111-111111111111", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      input: { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  });

  it("keeps two routines that genuinely share a name ambiguous", async () => {
    const ports = dependencies([
      routine({ id: "11111111-1111-4111-8111-111111111111", lineageId: "aaaa1111-1111-4111-8111-111111111111", status: "published" }),
      routine({ id: "22222222-2222-4222-8222-222222222222", lineageId: "bbbb2222-2222-4222-8222-222222222222", status: "published" }),
    ]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    expect(await tool.describeEntity!({ routineTitle: "support-intake" }, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).toMatchObject({ kind: "ambiguous" });
  });
});
