import { describe, expect, it } from "vitest";

import type { ConversationTrace, RoutineTraceSlotValue } from "@radioso/conversation-contract";

import {
  isPiiRoutineSlotType,
  maskPiiRoutineSlotValues,
  maskRoutineSubTracesForCustomerSurface,
  REDACTED_SLOT_VALUE_PLACEHOLDER,
} from "../../../src/modules/routines/routineTraceRedaction.js";

describe("isPiiRoutineSlotType", () => {
  it("flags email as PII", () => {
    expect(isPiiRoutineSlotType("email")).toBe(true);
  });

  it("does not flag text, number, boolean, or date", () => {
    expect(isPiiRoutineSlotType("text")).toBe(false);
    expect(isPiiRoutineSlotType("number")).toBe(false);
    expect(isPiiRoutineSlotType("boolean")).toBe(false);
    expect(isPiiRoutineSlotType("date")).toBe(false);
  });
});

describe("maskPiiRoutineSlotValues", () => {
  it("replaces a PII-typed slot's value with the redaction placeholder and leaves others untouched", () => {
    const slotValues: RoutineTraceSlotValue[] = [
      { key: "email", type: "email", value: "guest@example.com" },
      { key: "program", type: "text", value: "A stay at Ananda" },
      { key: "guests", type: "number", value: 2 },
    ];

    expect(maskPiiRoutineSlotValues(slotValues)).toEqual([
      { key: "email", type: "email", value: REDACTED_SLOT_VALUE_PLACEHOLDER },
      { key: "program", type: "text", value: "A stay at Ananda" },
      { key: "guests", type: "number", value: 2 },
    ]);
  });

  it("returns an empty array unchanged", () => {
    expect(maskPiiRoutineSlotValues([])).toEqual([]);
  });
});

describe("maskRoutineSubTracesForCustomerSurface", () => {
  const spineWithRoutineTrace = (slotValues: RoutineTraceSlotValue[]): ConversationTrace => ({
    traceId: "trace_1",
    startedAt: "2026-01-01T00:00:00.000Z",
    stages: [
      { id: "gather", kind: "gather", status: "applied" },
      {
        id: "routine:contact",
        kind: "routine_activate",
        status: "applied",
        subTrace: {
          namespace: "routine",
          version: 1,
          payload: {
            routineId: "contact",
            startStepId: "ask_email",
            landedStepId: "done",
            capturedSlotKeys: ["email"],
            filledSlotKeys: ["email"],
            slotValues,
            steps: [],
          },
        },
      },
    ],
  });

  it("masks a PII-typed slot value inside the routine sub-trace", () => {
    const spine = spineWithRoutineTrace([{ key: "email", type: "email", value: "guest@example.com" }]);

    const masked = maskRoutineSubTracesForCustomerSurface(spine);

    const routineStage = masked.stages.find((stage) => stage.subTrace?.namespace === "routine");
    expect(routineStage?.subTrace?.payload).toMatchObject({
      slotValues: [{ key: "email", type: "email", value: REDACTED_SLOT_VALUE_PLACEHOLDER }],
    });
  });

  it("leaves non-routine stages and non-PII slot values untouched", () => {
    const spine = spineWithRoutineTrace([{ key: "program", type: "text", value: "A stay at Ananda" }]);

    const masked = maskRoutineSubTracesForCustomerSurface(spine);

    expect(masked.stages[0]).toEqual(spine.stages[0]);
    const routineStage = masked.stages.find((stage) => stage.subTrace?.namespace === "routine");
    expect(routineStage?.subTrace?.payload).toMatchObject({
      slotValues: [{ key: "program", type: "text", value: "A stay at Ananda" }],
    });
  });

  it("does not mutate the input spine", () => {
    const spine = spineWithRoutineTrace([{ key: "email", type: "email", value: "guest@example.com" }]);
    const original = JSON.parse(JSON.stringify(spine));

    maskRoutineSubTracesForCustomerSurface(spine);

    expect(spine).toEqual(original);
  });

  it("leaves a spine with no routine sub-trace unchanged", () => {
    const spine: ConversationTrace = {
      traceId: "trace_2",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [{ id: "gather", kind: "gather", status: "applied" }],
    };

    expect(maskRoutineSubTracesForCustomerSurface(spine)).toEqual(spine);
  });
});
