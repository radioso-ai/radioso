import { describe, expect, it } from "vitest";

import type { Routine, RoutineState } from "@radioso/conversation-contract";

import { routineSlotSaves } from "../../../src/modules/routines/public.js";

const routine = {
  id: "routine_booking",
  steps: [
    { id: "ask_guests", kind: "chat" },
    { id: "booked", kind: "terminal", metadata: { terminalKind: "complete" } },
  ],
  slots: [
    { id: "s1", key: "guests", type: "number", required: true, saveTo: { contextVariable: "party_size", scope: "conversation" } },
    { id: "s2", key: "email", type: "email", required: true, saveTo: { contextVariable: "contact_email", scope: "person" } },
    { id: "s3", key: "injury", type: "text", required: false, sensitivity: "sensitive", saveTo: { contextVariable: "health_note", scope: "conversation" } },
    { id: "s4", key: "note", type: "text", required: false },
  ],
} as unknown as Routine;

const ended = (terminalKind: string | undefined, variables: Record<string, unknown>): RoutineState => ({
  routineId: "routine_booking",
  status: "completed",
  variables,
  path: [],
  metadata: terminalKind ? { terminalKind } : {},
} as unknown as RoutineState);

const values = { guests: 4, email: "guest@example.example", injury: "sprained ankle", note: "window seat" };

describe("routineSlotSaves", () => {
  it("saves each filled slot that names an attribute, as the visitor gave it, at a complete or handoff ending", () => {
    for (const terminalKind of ["complete", "handoff"]) {
      expect(routineSlotSaves(routine, ended(terminalKind, values))).toEqual([
        { slotKey: "guests", contextVariable: "party_size", scope: "conversation", value: 4, sensitive: false },
        { slotKey: "email", contextVariable: "contact_email", scope: "person", value: "guest@example.example", sensitive: false },
        { slotKey: "injury", contextVariable: "health_note", scope: "conversation", value: "sprained ankle", sensitive: true },
      ]);
    }
  });

  it("saves nothing for a run that got stuck, was declined consent, or has not ended", () => {
    expect(routineSlotSaves(routine, ended("stuck", values))).toEqual([]);
    expect(routineSlotSaves(routine, ended("consent_declined", values))).toEqual([]);
    expect(routineSlotSaves(routine, ended(undefined, values))).toEqual([]);
    expect(routineSlotSaves(routine, { ...ended("complete", values), status: "active" })).toEqual([]);
  });

  it("skips a slot the run never filled", () => {
    expect(routineSlotSaves(routine, ended("complete", { guests: 2 })).map((save) => save.slotKey)).toEqual(["guests"]);
  });

  it("re-saves only the fields a correction to the ended run changed, so a newer value of another field stays", () => {
    const endedRun = { ...ended("complete", values), executionId: "execution-1" };
    const corrected = { ...endedRun, variables: { ...values, email: "guest.two@example.example" } };

    expect(routineSlotSaves(routine, corrected, endedRun)).toEqual([
      { slotKey: "email", contextVariable: "contact_email", scope: "person", value: "guest.two@example.example", sensitive: false },
    ]);
  });

  it("saves every field of a run that ended this turn, whatever an earlier run of the routine held", () => {
    const earlierRun = { ...ended("complete", values), executionId: "execution-1" };
    const newRun = { ...ended("complete", values), executionId: "execution-2" };

    expect(routineSlotSaves(routine, newRun, earlierRun).map((save) => save.slotKey)).toEqual(["guests", "email", "injury"]);
  });

  it("reads how a run kept without its ending metadata ended from the terminal its path landed on, as the Postgres store keeps it (D1)", () => {
    const bare = (path: string[]): RoutineState => ({ ...ended(undefined, values), path, executionId: "execution-1" });
    const corrected = { ...bare(["ask_guests", "booked"]), variables: { ...values, guests: 5 } };

    expect(routineSlotSaves(routine, corrected, bare(["ask_guests", "booked"]))).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", value: 5, sensitive: false },
    ]);
    expect(routineSlotSaves(routine, bare(["ask_guests"]))).toEqual([]);
  });
});
