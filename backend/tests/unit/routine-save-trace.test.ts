import { describe, expect, it } from "vitest";

import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";
import { withRoutineSaveTrace } from "../../src/modules/chat/services/routines/routineSaveTrace.js";

const saves = [
  { slotKey: "guests", contextVariable: "party_size", scope: "conversation" as const, outcome: "written" },
  { slotKey: "email", contextVariable: "contact_email", scope: "person" as const, outcome: "no_person_key" },
];

const auditEvent = (stages: unknown[]): AuditEventInput => ({
  workspaceId: "workspace-1",
  eventType: "chat.answer",
  eventStatus: "success",
  metadata: { conversationId: "c-1", turnTrace: { version: 1, spine: { traceId: "t-1", stages } } },
});

const stagesOf = (event: AuditEventInput) => (event.metadata?.turnTrace as { spine: { stages: Array<Record<string, unknown>> } }).spine.stages;

describe("withRoutineSaveTrace", () => {
  it("adds the saves to the ending routine's own trace, keys and outcomes only", () => {
    const event = auditEvent([
      { id: "classify", kind: "classify", outputs: {} },
      { id: "routine:r-1", kind: "routine_resume", outputs: { routineId: "r-1" }, subTrace: { namespace: "routine", version: 1, payload: { routineId: "r-1", steps: [] } } },
    ]);

    const patched = withRoutineSaveTrace(event, "r-1", saves);

    expect(stagesOf(patched)[1]).toMatchObject({ subTrace: { payload: { routineId: "r-1", steps: [], saves } } });
    expect(stagesOf(event)[1]).not.toHaveProperty("subTrace.payload.saves");
  });

  it("puts them on the stage's outputs where the routine left no sub-trace, as a decision's resume does", () => {
    const patched = withRoutineSaveTrace(auditEvent([{ id: "routine-decision:r-1", kind: "routine", outputs: { routineId: "r-1" } }]), "r-1", saves);

    expect(stagesOf(patched)[0]).toMatchObject({ outputs: { routineId: "r-1", saves } });
  });

  it("leaves an event with no stage of that routine as it was", () => {
    const event = auditEvent([{ id: "routine:r-2", kind: "routine_resume", outputs: { routineId: "r-2" } }]);

    expect(withRoutineSaveTrace(event, "r-1", saves)).toBe(event);
    expect(withRoutineSaveTrace(event, "r-2", [])).toBe(event);
  });
});
