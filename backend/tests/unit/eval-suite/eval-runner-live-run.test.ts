import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseConversationQualityCases, type ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/cases.js";
import { voiceEvalCases } from "../../fixtures/voice-eval/cases.js";
import { scopeVoiceCasesForLiveRun } from "../../../scripts/runEvals.js";

const voiceCase = (overrides: Partial<ConversationQualityCase>): ConversationQualityCase => ({
  id: "voice-scope-case",
  name: "A voice case",
  tags: ["voice"],
  query: "Hello there",
  voiceTurn: { chatEvents: [{ type: "done" }] },
  assertions: [],
  ...overrides,
});

describe("live runner voice scope", () => {
  it("never gates a live voice case on latency: drops latency-dependent bridge assertions and the turn limit", () => {
    const [scoped] = scopeVoiceCasesForLiveRun([voiceCase({
      assertions: [
        { type: "voice_bridge_emitted", expected: false, latencyDependent: true },
        { type: "voice_turn_limit_reached", expected: false },
        { type: "voice_turn_outcome", kind: "continue" },
      ],
    })]);

    expect(scoped?.assertions).toEqual([{ type: "voice_turn_outcome", kind: "continue" }]);
  });

  it("keeps a bridge assertion the turn's phase decides, not its latency", () => {
    const [scoped] = scopeVoiceCasesForLiveRun([voiceCase({
      assertions: [{ type: "voice_bridge_emitted", expected: true }],
    })]);

    expect(scoped?.assertions).toEqual([{ type: "voice_bridge_emitted", expected: true }]);
  });

  it("skips a deterministic-only voice case", () => {
    const scoped = scopeVoiceCasesForLiveRun([
      voiceCase({ id: "runs-live", assertions: [{ type: "voice_turn_outcome", kind: "continue" }] }),
      voiceCase({
        id: "scripted-only",
        voiceTurn: { chatEvents: [{ type: "stall" }], deterministicOnly: true },
        assertions: [{ type: "voice_turn_limit_reached", expected: true }],
      }),
    ]);

    expect(scoped.map((evalCase) => evalCase.id)).toEqual(["runs-live"]);
  });

  it("refuses a live voice case left with nothing to gate", () => {
    expect(() => scopeVoiceCasesForLiveRun([voiceCase({
      id: "gates-nothing",
      assertions: [{ type: "voice_bridge_emitted", expected: false, latencyDependent: true }],
    })])).toThrow(/"gates-nothing".*deterministicOnly/u);
  });

  it("leaves text cases as they are", () => {
    const committed = parseConversationQualityCases(conversationQualityCases);

    expect(scopeVoiceCasesForLiveRun(committed)).toEqual(committed);
  });

  it("runs the committed voice cases live on behaviour alone, without the turn-limit case", () => {
    const scoped = scopeVoiceCasesForLiveRun(parseConversationQualityCases(voiceEvalCases));

    expect(Object.fromEntries(scoped.map((evalCase) => [evalCase.id, evalCase.assertions]))).toEqual({
      "voice-bridge-on-searching": [
        { type: "voice_bridge_emitted", expected: true },
        { type: "voice_turn_outcome", kind: "continue" },
      ],
      "voice-quick-reply-no-bridge": [{ type: "voice_turn_outcome", kind: "continue" }],
      "voice-outcome-handoff": [{ type: "voice_turn_outcome", kind: "callback_requested" }],
    });
  });

  it("holds a committed baseline entry for every voice case a live run drives, and none for a deterministic-only one", () => {
    const baseline = JSON.parse(
      readFileSync(new URL("../../fixtures/conversation-quality/baseline.json", import.meta.url), "utf8"),
    ) as { cases: Record<string, unknown> };
    const recordedVoiceCases = Object.keys(baseline.cases).filter((caseId) => voiceEvalCases.some((evalCase) => evalCase.id === caseId));

    expect(recordedVoiceCases.sort()).toEqual(
      scopeVoiceCasesForLiveRun(parseConversationQualityCases(voiceEvalCases)).map((evalCase) => evalCase.id).sort(),
    );
  });
});
