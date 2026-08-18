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
    expect(JSON.stringify(result)).not.toContain("xxx");
  });
});
