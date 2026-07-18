import { afterEach, describe, expect, it } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import {
  TURN_TRACE_ENVELOPE_VERSION,
  attachCapabilitySubTrace,
  attachContextVariablesToGather,
  buildTurnTraceEnvelope,
  setTurnTraceOpenTelemetryCorrelationReader,
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

describe("attachContextVariablesToGather", () => {
  it("attaches the redacted context snapshot onto the gather stage outputs", () => {
    const result = attachContextVariablesToGather(spine(), {
      page_context: { kind: "page_context", pageUrl: "https://x.test" },
      ssn: "[redacted]",
    });

    const gather = result.stages.find((stage) => stage.id === "gather");
    expect(gather?.outputs?.contextVariables).toEqual({
      page_context: { kind: "page_context", pageUrl: "https://x.test" },
      ssn: "[redacted]",
    });
    // Other stages untouched.
    expect(result.stages.find((stage) => stage.id === "compose")?.outputs).toBeUndefined();
  });

  it("preserves existing gather outputs and merges context variables", () => {
    const withHistory: ConversationTrace = {
      ...spine(),
      stages: [{ id: "gather", kind: "gather", status: "applied", outputs: { historyCount: 3 } }],
    };
    const result = attachContextVariablesToGather(withHistory, { cart: { items: 2 } });
    expect(result.stages[0]?.outputs).toEqual({ historyCount: 3, contextVariables: { cart: { items: 2 } } });
  });

  it("no-ops for an empty snapshot or when there is no gather stage", () => {
    const original = spine();
    expect(attachContextVariablesToGather(original, {})).toBe(original);
    const noGather: ConversationTrace = { ...original, stages: original.stages.filter((s) => s.kind !== "gather") };
    expect(attachContextVariablesToGather(noGather, { cart: 1 })).toBe(noGather);
  });
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
  afterEach(() => {
    setTurnTraceOpenTelemetryCorrelationReader(undefined);
  });

  it("stamps the current envelope version and carries the spine", () => {
    const envelope = buildTurnTraceEnvelope({ spine: spine() });
    expect(envelope.version).toBe(TURN_TRACE_ENVELOPE_VERSION);
    expect(envelope.spine.traceId).toBe("conversation-turn-1");
    expect(envelope.summary).toEqual({
      totalLlmCalls: 0,
      serialLlmDepth: 0,
      longestStage: { name: "gather", durationMs: 0 },
      totalModelTimeMs: 0,
      totalTurnWallClockMs: 0,
    });
    expect(envelope.openTelemetry).toBeUndefined();
  });

  it("accepts a generic summary roll-up and a version override", () => {
    const envelope = buildTurnTraceEnvelope({
      spine: spine(),
      summary: { outcome: "answered" },
      version: 0,
    });
    expect(envelope.version).toBe(0);
    expect(envelope.summary).toEqual({
      totalLlmCalls: 0,
      serialLlmDepth: 0,
      longestStage: { name: "gather", durationMs: 0 },
      totalModelTimeMs: 0,
      totalTurnWallClockMs: 0,
      outcome: "answered",
    });
  });

  it("does not stamp synthesized legacy envelopes with the current request trace", () => {
    setTurnTraceOpenTelemetryCorrelationReader({
      getActiveOpenTelemetryCorrelation: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        sampled: true,
      }),
    });

    expect(buildTurnTraceEnvelope({ spine: spine(), version: 0 })).not.toHaveProperty("openTelemetry");
  });

  it("adds active OpenTelemetry correlation when a reader is wired", () => {
    setTurnTraceOpenTelemetryCorrelationReader({
      getActiveOpenTelemetryCorrelation: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        sampled: true,
      }),
    });

    expect(buildTurnTraceEnvelope({ spine: spine() })).toMatchObject({
      openTelemetry: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        sampled: true,
      },
    });
  });

  it("omits OpenTelemetry correlation when the reader has no active trace", () => {
    setTurnTraceOpenTelemetryCorrelationReader({
      getActiveOpenTelemetryCorrelation: () => undefined,
    });

    expect(buildTurnTraceEnvelope({ spine: spine() })).not.toHaveProperty("openTelemetry");
  });

  it("omits malformed OpenTelemetry correlation instead of embedding SDK-shaped data", () => {
    setTurnTraceOpenTelemetryCorrelationReader({
      getActiveOpenTelemetryCorrelation: () => ({
        traceId: "trace",
        spanId: "",
        sampled: true,
        sdkSpan: { unsafe: true },
      } as never),
    });

    expect(buildTurnTraceEnvelope({ spine: spine() })).not.toHaveProperty("openTelemetry");
  });
});
