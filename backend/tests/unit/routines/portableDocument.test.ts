import { describe, expect, it } from "vitest";

import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import { projectRoutineToPortableDocument } from "../../../src/modules/routines/portableDocument.js";

const guesthouseBooking = (startMode: "automatic" | "offer"): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "Book a room",
  version: 1,
  enabled: true,
  activation: {
    triggerDescription: "A guest wants to book a room.",
    gateRef: null,
    priority: 0,
    reentryMode: "once_per_conversation",
    startMode,
  },
  slots: [],
  steps: [
    { stableStepId: "ask_dates", kind: "chat", instruction: "Ask for the arrival and departure dates.", toolRef: null, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_dates", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm the request.", ordinal: 0 },
  ],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
});

describe("projectRoutineToPortableDocument start mode", () => {
  it("writes an offer-first start mode into the portable header", () => {
    const result = projectRoutineToPortableDocument(guesthouseBooking("offer"));

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.envelope.content).toContain("start: offer");
  });

  it("writes nothing for a routine that starts automatically", () => {
    const result = projectRoutineToPortableDocument(guesthouseBooking("automatic"));

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.envelope.content).not.toContain("start:");
  });
});
