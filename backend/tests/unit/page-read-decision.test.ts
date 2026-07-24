import type { Routine } from "@radioso/conversation-contract";
import { describe, expect, it } from "vitest";

import {
  evaluatePageReadGate,
  mergePageReadDecision,
  type PageReadCandidate,
  type PageReadCapability,
  type PageReadDecision,
} from "../../src/modules/chat/services/pageRead/pageReadDecision.js";
import { pageReadRoutineCandidates } from "../../src/modules/chat/services/pageRead/pageReadRoutineCandidates.js";

const plannerDecision = (
  operation: Exclude<PageReadDecision, { required: false }>["operation"],
  resolvedRequest: string,
): PageReadDecision => ({
  required: true,
  operation,
  resolvedRequest,
});

const merge = (overrides: Partial<Parameters<typeof mergePageReadDecision>[0]> = {}) =>
  mergePageReadDecision({
    planner: null,
    routineCandidates: [],
    directiveCandidates: [],
    fallbackRequest: "latest resolved request",
    ...overrides,
  });

describe("mergePageReadDecision", () => {
  it("returns not required when there are no candidates", () => {
    expect(merge()).toEqual({
      decision: { required: false, operation: null, resolvedRequest: null },
      contributors: [],
    });
  });

  it("uses a required planner decision as the only candidate", () => {
    expect(merge({ planner: plannerDecision("lookup", "planner request") })).toEqual({
      decision: { required: true, operation: "lookup", resolvedRequest: "planner request" },
      contributors: [{
        source: { kind: "planner" },
        operation: "lookup",
        resolvedRequest: "planner request",
      }],
    });
  });

  it("does not add a planner candidate for a not-required decision", () => {
    expect(merge({
      planner: { required: false, operation: null, resolvedRequest: null },
    })).toEqual({
      decision: { required: false, operation: null, resolvedRequest: null },
      contributors: [],
    });
  });

  it("lets a routine beat a broader planner operation by authority", () => {
    expect(merge({
      planner: plannerDecision("transform", "planner request"),
      routineCandidates: [{
        source: { kind: "routine", routineId: "routine-a" },
        operation: "metadata",
        resolvedRequest: "routine request",
      }],
    }).decision).toEqual({
      required: true,
      operation: "metadata",
      resolvedRequest: "routine request",
    });
  });

  it("orders operation breadth within the same authority", () => {
    const candidates: PageReadCandidate[] = [
      { source: { kind: "directive", directiveId: "metadata" }, operation: "metadata" },
      { source: { kind: "directive", directiveId: "lookup" }, operation: "lookup" },
      { source: { kind: "directive", directiveId: "summarize" }, operation: "summarize" },
      { source: { kind: "directive", directiveId: "transform" }, operation: "transform" },
    ];

    expect(merge({ directiveCandidates: candidates }).contributors.map(({ operation }) => operation))
      .toEqual(["transform", "summarize", "lookup", "metadata"]);
  });

  it("uses the stable source id as the final tie-break", () => {
    const result = merge({
      routineCandidates: [
        { source: { kind: "routine", routineId: "zeta" }, resolvedRequest: "zeta request" },
        { source: { kind: "routine", routineId: "alpha" }, resolvedRequest: "alpha request" },
      ],
    });

    expect(result.contributors.map(({ source }) => source)).toEqual([
      { kind: "routine", routineId: "alpha" },
      { kind: "routine", routineId: "zeta" },
    ]);
  });

  it("takes both winning fields from one candidate instead of mixing them", () => {
    expect(merge({
      routineCandidates: [{
        source: { kind: "routine", routineId: "routine-a" },
        operation: "lookup",
        resolvedRequest: "routine request",
      }],
      directiveCandidates: [{
        source: { kind: "directive", directiveId: "directive-a" },
        operation: "summarize",
        resolvedRequest: "directive request",
      }],
    }).decision).toEqual({
      required: true,
      operation: "lookup",
      resolvedRequest: "routine request",
    });
  });

  it("defaults omitted operation and request before sorting and recording contributors", () => {
    expect(merge({
      routineCandidates: [{ source: { kind: "routine", routineId: "routine-a" } }],
    })).toEqual({
      decision: {
        required: true,
        operation: "lookup",
        resolvedRequest: "latest resolved request",
      },
      contributors: [{
        source: { kind: "routine", routineId: "routine-a" },
        operation: "lookup",
        resolvedRequest: "latest resolved request",
      }],
    });
  });

  it("keeps every defaulted contributor in winner-first order", () => {
    const result = merge({
      planner: plannerDecision("summarize", "planner request"),
      routineCandidates: [{
        source: { kind: "routine", routineId: "routine-b" },
        operation: "metadata",
        resolvedRequest: "routine request",
      }],
      directiveCandidates: [{
        source: { kind: "directive", directiveId: "directive-a" },
        operation: "transform",
        resolvedRequest: "directive request",
      }],
    });

    expect(result.contributors).toEqual([
      {
        source: { kind: "routine", routineId: "routine-b" },
        operation: "metadata",
        resolvedRequest: "routine request",
      },
      {
        source: { kind: "directive", directiveId: "directive-a" },
        operation: "transform",
        resolvedRequest: "directive request",
      },
      {
        source: { kind: "planner" },
        operation: "summarize",
        resolvedRequest: "planner request",
      },
    ]);
  });
});

describe("evaluatePageReadGate", () => {
  const capability = (
    overrides: Partial<PageReadCapability> = {},
  ): PageReadCapability => ({
    available: true,
    mode: "content",
    supportedOperations: ["metadata", "lookup", "summarize"],
    ...overrides,
  });

  it("returns not_required before inspecting capability", () => {
    expect(evaluatePageReadGate(merge(), null)).toEqual({ kind: "not_required" });
  });

  it("returns unavailable when capability is absent or unavailable", () => {
    const required = merge({ planner: plannerDecision("lookup", "request") });
    expect(evaluatePageReadGate(required, null)).toEqual({ kind: "unavailable" });
    expect(evaluatePageReadGate(required, capability({ available: false }))).toEqual({ kind: "unavailable" });
  });

  it("returns unsupported_operation for transform before checking supported operations", () => {
    const required = merge({ planner: plannerDecision("transform", "translate the page") });
    expect(evaluatePageReadGate(
      required,
      capability({ supportedOperations: ["metadata", "lookup", "summarize"] }),
    )).toEqual({ kind: "unsupported_operation" });
  });

  it("returns unavailable before transform handling when capability is unavailable", () => {
    const required = merge({ planner: plannerDecision("transform", "translate the page") });
    expect(evaluatePageReadGate(
      required,
      capability({ available: false, supportedOperations: [] }),
    )).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when an otherwise supported operation is not advertised", () => {
    const required = merge({ planner: plannerDecision("summarize", "summarize the page") });
    expect(evaluatePageReadGate(
      required,
      capability({ supportedOperations: ["metadata", "lookup"] }),
    )).toEqual({ kind: "unavailable" });
  });

  it("returns capture with the selected request for an advertised operation", () => {
    const required = merge({ planner: plannerDecision("lookup", "find the return window") });
    expect(evaluatePageReadGate(required, capability())).toEqual({
      kind: "capture",
      operation: "lookup",
      resolvedRequest: "find the return window",
    });
  });
});

describe("pageReadRoutineCandidates", () => {
  it("maps each page_context binding using the routine as its source and leaves defaults omitted", () => {
    const routine = {
      id: "routine-a",
      rootStepId: "step-a",
      transitions: [],
      steps: [{
        id: "step-a",
        kind: "skill",
        inputBindings: {
          page: { kind: "contextVariableRef", contextVariable: "page_context" },
          locale: { kind: "contextVariableRef", contextVariable: "page_locale" },
        },
      }],
    } satisfies Routine;

    expect(pageReadRoutineCandidates(routine)).toEqual([{
      source: { kind: "routine", routineId: "routine-a" },
    }]);
  });
});
