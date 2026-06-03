import { describe, expect, it } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import {
  TURN_TRACE_ENVELOPE_VERSION,
  attachCapabilitySubTrace,
  buildTurnTraceEnvelope,
  synthesizeDispatchSpine,
} from "../../src/modules/chat/services/turnTraceEnvelope.js";

const spine = (): ConversationTrace => ({
  traceId: "conversation-turn-1",
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString(),
  stages: [
    { id: "gather", kind: "gather", status: "applied" },
    { id: "selection", kind: "skill_selection", status: "applied" },
    { id: "dispatch:retrieval-answer", kind: "skill_dispatch", status: "applied" },
    { id: "compose", kind: "compose", status: "applied" },
  ],
});

describe("attachCapabilitySubTrace", () => {
  it("attaches the sub-trace onto the matching dispatch stage", () => {
    const subTrace = { namespace: "retrieval", version: 1, payload: { candidates: 5 } };

    const result = attachCapabilitySubTrace(spine(), {
      skillName: "retrieval-answer",
      subTrace,
    });

    const dispatchStage = result.stages.find((stage) => stage.id === "dispatch:retrieval-answer");
    expect(dispatchStage?.subTrace).toEqual(subTrace);
    // Other stages are untouched.
    expect(result.stages.find((stage) => stage.id === "gather")?.subTrace).toBeUndefined();
  });

  it("no-ops when no dispatch stage matches the skill name", () => {
    const original = spine();
    const result = attachCapabilitySubTrace(original, {
      skillName: "missing-skill",
      subTrace: { namespace: "retrieval", version: 1, payload: {} },
    });

    expect(result).toEqual(original);
    expect(result.stages.every((stage) => stage.subTrace === undefined)).toBe(true);
  });

  it("does not mutate the input spine", () => {
    const original = spine();
    attachCapabilitySubTrace(original, {
      skillName: "retrieval-answer",
      subTrace: { namespace: "retrieval", version: 1, payload: {} },
    });
    expect(original.stages.find((stage) => stage.id === "dispatch:retrieval-answer")?.subTrace).toBeUndefined();
  });
});

describe("synthesizeDispatchSpine", () => {
  it("builds a single-dispatch spine carrying the sub-trace", () => {
    const subTrace = { namespace: "skill-intake", version: 1, payload: { collected: true } };
    const spine = synthesizeDispatchSpine({
      skillName: "contact.collect",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1000).toISOString(),
      subTrace,
    });

    expect(spine.stages).toHaveLength(1);
    expect(spine.stages[0]).toMatchObject({
      id: "dispatch:contact.collect",
      kind: "skill_dispatch",
      status: "applied",
      subTrace,
    });
    expect(spine.startedAt).toBe(new Date(0).toISOString());
    expect(spine.completedAt).toBe(new Date(1000).toISOString());
    // The synthesized spine is a valid attach target for the generic helper.
    expect(attachCapabilitySubTrace(spine, { skillName: "contact.collect", subTrace }).stages[0].subTrace)
      .toEqual(subTrace);
  });

  it("defaults status to applied and completedAt to startedAt", () => {
    const spine = synthesizeDispatchSpine({
      skillName: "x",
      startedAt: new Date(0).toISOString(),
    });
    expect(spine.stages[0].status).toBe("applied");
    expect(spine.completedAt).toBe(new Date(0).toISOString());
    expect(spine.stages[0].subTrace).toBeUndefined();
  });

  it("honors an explicit failed status", () => {
    const spine = synthesizeDispatchSpine({
      skillName: "x",
      status: "failed",
      startedAt: new Date(0).toISOString(),
    });
    expect(spine.stages[0].status).toBe("failed");
  });
});

describe("envelope shape is pinned (forcing function for version bumps)", () => {
  // This test trips on ANY change to the envelope/spine-stage shape. When it fails,
  // decide: additive (new stage key, new leaf namespace) -> update the expected keys
  // here, NO version bump; breaking (renamed/removed field, changed semantics) ->
  // bump TURN_TRACE_ENVELOPE_VERSION AND add a matching read-path branch + legacy test.
  // The opaque leaf payload is intentionally NOT pinned — capabilities own their own
  // CapabilitySubTrace.version.
  it("has a stable top-level and dispatch-stage key set", () => {
    const envelope = buildTurnTraceEnvelope({
      spine: attachCapabilitySubTrace(spine(), {
        skillName: "retrieval-answer",
        subTrace: { namespace: "retrieval", version: 1, payload: { candidates: 5 } },
      }),
      summary: { outcome: "answered" },
    });

    expect(Object.keys(envelope).sort()).toEqual(["spine", "summary", "version"]);
    expect(Object.keys(envelope.spine).sort()).toEqual([
      "completedAt",
      "stages",
      "startedAt",
      "traceId",
    ]);

    const dispatchStage = envelope.spine.stages.find((stage) => stage.subTrace);
    expect(Object.keys(dispatchStage ?? {}).sort()).toEqual(["id", "kind", "status", "subTrace"]);
    expect(Object.keys(dispatchStage?.subTrace ?? {}).sort()).toEqual([
      "namespace",
      "payload",
      "version",
    ]);
  });
});

describe("buildTurnTraceEnvelope", () => {
  it("stamps the current envelope version and carries the spine", () => {
    const envelope = buildTurnTraceEnvelope({ spine: spine() });
    expect(envelope.version).toBe(TURN_TRACE_ENVELOPE_VERSION);
    expect(envelope.spine.traceId).toBe("conversation-turn-1");
    expect(envelope.summary).toBeUndefined();
  });

  it("accepts a generic summary roll-up and a version override", () => {
    const envelope = buildTurnTraceEnvelope({
      spine: spine(),
      summary: { outcome: "answered" },
      version: 0,
    });
    expect(envelope.version).toBe(0);
    expect(envelope.summary).toEqual({ outcome: "answered" });
  });
});
