import { describe, expect, it } from "vitest";

import { appendDirectiveSteeringStage } from "../../src/modules/chat/services/directiveTracePresenter.js";
import type { ActivityTrace } from "../../src/modules/retrieval/public.js";
import type { DirectiveSteeringResult } from "../../src/modules/directives/public.js";

const baseTrace = (): ActivityTrace => ({
  traceId: "t1",
  startedAt: new Date().toISOString(),
  stages: [{ stageId: "answer", kind: "answer_outcome", label: "Answer outcome", status: "applied" }],
  links: [],
});

describe("appendDirectiveSteeringStage", () => {
  it("leaves the trace untouched when nothing matched or was omitted", () => {
    const trace = baseTrace();
    const empty: DirectiveSteeringResult = { rules: [], matches: [], omissions: [] };
    expect(appendDirectiveSteeringStage(trace, empty)).toBe(trace);
    expect(appendDirectiveSteeringStage(trace, undefined)).toBe(trace);
  });

  it("records matched and omitted directives as a stage with parity to skill tracing", () => {
    const steering: DirectiveSteeringResult = {
      rules: [],
      matches: [
        {
          directive: { name: "be-concise", condition: { kind: "always" }, action: "be concise" },
          selectionMode: "deterministic",
          selectionReason: "always",
        },
      ],
      omissions: [{ directiveName: "gated", reason: "capability_denied" }],
    };

    const traced = appendDirectiveSteeringStage(baseTrace(), steering);
    const stage = traced.stages.at(-1)!;
    expect(stage.stageId).toBe("directive_steering");
    expect(stage.outputs?.matched).toEqual([
      { name: "be-concise", selectionMode: "deterministic", selectionReason: "always", selectionConfidence: undefined },
    ]);
    expect(stage.outputs?.omitted).toEqual([{ directiveName: "gated", reason: "capability_denied" }]);
    expect(traced.links).toContainEqual({ fromStageId: "answer", toStageId: "directive_steering", kind: "sequence" });
  });
});
