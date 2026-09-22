import { describe, expect, it } from "vitest";

import { validateExposureAcrossSnapshot } from "../../../src/modules/routines/exposure/exposureSnapshotRules.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";

const routine = (
  overrides: Partial<RoutineDefinition> & { id: string; lineageId?: string },
): RoutineDefinition => ({
  agentId: "agent_1",
  lineageId: overrides.id,
  name: overrides.id,
  version: 1,
  enabled: true,
  activation: { triggerDescription: "When asked.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
  createdAt: new Date("2026-09-21T00:00:00.000Z"),
  updatedAt: new Date("2026-09-21T00:00:00.000Z"),
  ...overrides,
});

const exposure = (toolName: string, enabled = true) => ({ enabled, toolName, description: "" });

describe("validateExposureAcrossSnapshot", () => {
  it("passes a first publish with distinct enabled tool names and no published predecessor", () => {
    const diagnostics = validateExposureAcrossSnapshot([
      routine({ id: "a", exposure: exposure("start_return") }),
      routine({ id: "b", exposure: exposure("request_callback") }),
      routine({ id: "c" }),
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("reports every routine that shares an enabled tool name", () => {
    const diagnostics = validateExposureAcrossSnapshot([
      routine({ id: "a", exposure: exposure("start_return") }),
      routine({ id: "b", exposure: exposure("start_return") }),
      routine({ id: "c", exposure: exposure("start_return", false) }),
    ]);
    expect(diagnostics.map((diagnostic) => [diagnostic.routineId, diagnostic.code])).toEqual([
      ["a", "exposure_tool_name_duplicate"],
      ["b", "exposure_tool_name_duplicate"],
    ]);
    expect(diagnostics[0]).toMatchObject({ location: "exposure.toolName", message: expect.stringContaining("start_return") });
  });

  it("does not count a parked routine's exposure toward duplicates, the same way structural checks skip it", () => {
    const diagnostics = validateExposureAcrossSnapshot([
      routine({ id: "a", exposure: exposure("start_return") }),
      routine({ id: "b", enabled: false, exposure: exposure("start_return") }),
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("refuses a renamed tool once the lineage has published a name (AS-8)", () => {
    const published = [routine({ id: "a", exposure: exposure("start_return") })];
    const diagnostics = validateExposureAcrossSnapshot(
      [routine({ id: "a2", lineageId: "a", exposure: exposure("begin_return") })],
      published,
    );
    expect(diagnostics).toEqual([expect.objectContaining({
      routineId: "a2",
      code: "exposure_tool_name_changed",
      location: "exposure.toolName",
      message: expect.stringContaining("start_return"),
    })]);
  });

  it("refuses dropping the block once the lineage has published a name", () => {
    const published = [routine({ id: "a", exposure: exposure("start_return") })];
    expect(validateExposureAcrossSnapshot([routine({ id: "a" })], published))
      .toEqual([expect.objectContaining({ routineId: "a", code: "exposure_tool_name_changed" })]);
  });

  it("keeps the frozen name while the exposure is disabled and lets the routine keep it (Decision 3)", () => {
    const published = [routine({ id: "a", exposure: exposure("start_return") })];
    expect(validateExposureAcrossSnapshot([routine({ id: "a", exposure: exposure("start_return", false) })], published)).toEqual([]);
    const republished = [routine({ id: "a", exposure: exposure("start_return", false) })];
    expect(validateExposureAcrossSnapshot([routine({ id: "a", exposure: exposure("begin_return") })], republished))
      .toEqual([expect.objectContaining({ code: "exposure_tool_name_changed" })]);
  });

  it("lets a lineage that never published a name take one, and a deleted lineage free its name", () => {
    const published = [routine({ id: "a" }), routine({ id: "b", exposure: exposure("start_return") })];
    expect(validateExposureAcrossSnapshot([
      routine({ id: "a", exposure: exposure("request_callback") }),
      routine({ id: "c", exposure: exposure("start_return") }),
    ], published)).toEqual([]);
  });

  it("ignores a published block with an empty name", () => {
    const published = [routine({ id: "a", exposure: exposure("", false) })];
    expect(validateExposureAcrossSnapshot([routine({ id: "a", exposure: exposure("start_return") })], published)).toEqual([]);
  });
});
