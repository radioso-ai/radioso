import { describe, expect, it } from "vitest";

import {
  appendConversationSummaryStage,
  appendDirectiveSteeringStage,
} from "../../src/modules/chat/contracts/index.js";
import type { ActivityTrace } from "../../src/modules/retrieval/public.js";
import type { DirectiveSteeringResult } from "../../src/modules/directives/public.js";

const baseTrace = (): ActivityTrace => ({
  traceId: "t1",
  startedAt: new Date().toISOString(),
  stages: [{ stageId: "answer", kind: "answer_outcome", label: "Answer outcome", status: "applied" }],
  links: [],
});

describe("appendConversationSummaryStage", () => {
  it("leaves the trace untouched when there is no summary", () => {
    const trace = baseTrace();
    expect(appendConversationSummaryStage(trace, undefined)).toBe(trace);
    expect(appendConversationSummaryStage(trace, null)).toBe(trace);
    expect(appendConversationSummaryStage(trace, "")).toBe(trace);
    expect(appendConversationSummaryStage(trace, "   ")).toBe(trace);
  });

  it("records the injected summary as a stage with its length and injection sites", () => {
    const summary = "User is planning a trip to Osaka and asked about visa rules.";
    const traced = appendConversationSummaryStage(baseTrace(), summary);
    const stage = traced.stages.at(-1)!;

    expect(stage.stageId).toBe("conversation_summary");
    expect(stage.kind).toBe("conversation_summary");
    expect(stage.label).toBe("Conversation summary");
    expect(stage.status).toBe("applied");
    expect(stage.outputs?.summary).toBe(summary);
    expect(stage.outputs?.summaryChars).toBe(summary.length);
    expect(stage.outputs?.injectedInto).toEqual([
      "turn_interpretation",
      "grounded_answer",
      "direct_answer",
    ]);
    expect(traced.links).toContainEqual({
      fromStageId: "answer",
      toStageId: "conversation_summary",
      kind: "sequence",
    });
  });

  it("appends after the directive-steering stage when both apply", () => {
    const steering: DirectiveSteeringResult = {
      rules: [],
      matches: [
        {
          directive: { name: "be-concise", condition: { kind: "always" }, action: "be concise" },
          selectionMode: "deterministic",
          selectionReason: "always",
        },
      ],
      omissions: [],
    };

    const traced = appendConversationSummaryStage(
      appendDirectiveSteeringStage(baseTrace(), steering),
      "Rolling summary of the conversation.",
    );

    const kinds = traced.stages.map((stage) => stage.kind);
    expect(kinds).toEqual(["answer_outcome", "directive_steering", "conversation_summary"]);
    expect(traced.links).toContainEqual({
      fromStageId: "directive_steering",
      toStageId: "conversation_summary",
      kind: "sequence",
    });
  });
});
