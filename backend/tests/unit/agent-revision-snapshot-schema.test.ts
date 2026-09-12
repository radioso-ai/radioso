import { describe, expect, it } from "vitest";

import {
  assertCandidateSnapshotIsRunnable,
  parseAgentRevisionSnapshot,
} from "../../src/modules/agents/public.js";

const routineSnapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  lineageId: "33333333-3333-4333-8333-333333333333",
  version: 1,
  name: "Order status",
  activation: {
    triggerDescription: "customer asks where their order is",
    gateRef: null,
    priority: 50,
    reentryMode: "once_per_conversation",
  },
  slots: [],
  steps: [
    { stableStepId: "ask", kind: "chat", instruction: "Ask for the order number.", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const snapshotWith = (routines: Record<string, unknown>[]): Record<string, unknown> => ({
  customInstruction: null,
  directives: [],
  routines,
  contextVariableEnablements: [],
});

describe("agent revision snapshot schema", () => {
  it("parses a revision written before routines carried an enabled flag", () => {
    // Every revision already frozen in staging and production carries `status` on each
    // routine and no `enabled`. A pinned conversation re-parses its snapshot on every
    // turn, so refusing the retired key would take out every in-flight conversation.
    const legacy = snapshotWith([
      routineSnapshot({ status: "published" }),
      routineSnapshot({ id: "44444444-4444-4444-8444-444444444444", status: "draft" }),
    ]);

    const parsed = parseAgentRevisionSnapshot(legacy);

    expect(parsed.routines.map((routine) => routine.enabled)).toEqual([true, true]);
    expect(parsed.routines[0]).not.toHaveProperty("status");
    expect(() => assertCandidateSnapshotIsRunnable(parsed)).not.toThrow();
  });

  it("parses a retained cutover routine written before the enabled flag", () => {
    const legacy = {
      ...snapshotWith([routineSnapshot({ status: "published" })]),
      retainedRoutineDefinitions: [routineSnapshot({ id: "55555555-5555-4555-8555-555555555555", status: "superseded", version: 2 })],
    };

    const parsed = parseAgentRevisionSnapshot(legacy);

    expect(parsed.retainedRoutineDefinitions?.[0]?.enabled).toBe(true);
  });

  it("releases a candidate whose disabled routine cannot be released on its own", () => {
    // A routine that cannot activate cannot break a conversation, so parking a
    // half-finished flow must not block the agent's Review & Publish.
    const broken = routineSnapshot({
      id: "66666666-6666-4666-8666-666666666666",
      enabled: false,
      transitions: [],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
    });

    const parked = parseAgentRevisionSnapshot(snapshotWith([routineSnapshot(), broken]));
    expect(() => assertCandidateSnapshotIsRunnable(parked)).not.toThrow();

    const live = parseAgentRevisionSnapshot(snapshotWith([routineSnapshot(), { ...broken, enabled: true }]));
    expect(() => assertCandidateSnapshotIsRunnable(live)).toThrow(/cannot be released/u);
  });
});
