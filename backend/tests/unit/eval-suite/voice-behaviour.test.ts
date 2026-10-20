import { describe, expect, it } from "vitest";

import {
  parseConversationQualityCases,
  runConversationQualitySuite,
  type ConversationQualityCase,
} from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/cases.js";
import { voiceEvalCases } from "../../fixtures/voice-eval/cases.js";
import { createDeterministicVoiceTurnPort } from "../../fixtures/voice-eval/deterministicPort.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const runCase = async (evalCase: ConversationQualityCase) => {
  const { reports } = await runConversationQualitySuite([evalCase], createDeterministicVoiceTurnPort(), {
    workspaceId: WORKSPACE_ID,
  });
  return reports[0];
};

const caseNamed = (id: string): ConversationQualityCase => {
  const evalCase = voiceEvalCases.find((candidate) => candidate.id === id);
  if (!evalCase) {
    throw new Error(`No voice eval case named "${id}"`);
  }
  return evalCase;
};

/**
 * The deterministic half of the voice eval cases (#1528): driven through a real
 * `VoiceTurnService` — the same policy, outcome derivation and lines production runs — over a
 * scripted chat backend and the `generic` dialect's vendor tag, instead of a real model call.
 * `tests/fixtures/voice-eval/` holds the cases and the runner; `scripts/runEvals.ts` runs the
 * same cases nightly against the real brain.
 */
describe("voice conversation-quality cases", () => {
  it("bridges while the turn searches", async () => {
    const report = await runCase(caseNamed("voice-bridge-on-searching"));
    expect(report).toMatchObject({ status: "pass" });
  });

  it("answers a thank-you with no bridge", async () => {
    const report = await runCase(caseNamed("voice-quick-reply-no-bridge"));
    expect(report).toMatchObject({ status: "pass" });
  });

  it("falls back once the turn limit passes with nothing said", async () => {
    const report = await runCase(caseNamed("voice-turn-limit-fires"));
    expect(report).toMatchObject({ status: "pass" });
  });

  it("reports a callback outcome once a hand-off collects a slot", async () => {
    const report = await runCase(caseNamed("voice-outcome-handoff"));
    expect(report).toMatchObject({ status: "pass" });
  });

  it("ships exactly the committed voice cases, each tagged voice", () => {
    expect(voiceEvalCases.map((evalCase) => evalCase.id)).toEqual([
      "voice-bridge-on-searching",
      "voice-quick-reply-no-bridge",
      "voice-turn-limit-fires",
      "voice-outcome-handoff",
    ]);
    expect(voiceEvalCases.every((evalCase) => evalCase.tags?.includes("voice"))).toBe(true);
  });

  it("validates against the committed case schema and keeps its ids unique next to the text cases, the way runEvals.ts combines them", () => {
    expect(() => parseConversationQualityCases([...conversationQualityCases, ...voiceEvalCases])).not.toThrow();
  });
});
