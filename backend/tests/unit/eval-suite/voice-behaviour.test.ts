import { describe, expect, it } from "vitest";

import { parseTurnPlan } from "../../../src/modules/chat/services/turnPlanService.js";
import {
  parseConversationQualityCases,
  runConversationQualitySuite,
  type ConversationQualityCase,
} from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/cases.js";
import { voiceEvalCases } from "../../fixtures/voice-eval/cases.js";
import { createDeterministicVoiceTurnPort } from "../../fixtures/voice-eval/deterministicPort.js";
import {
  scriptedPlanText,
  voiceEvalBrainAnsweringDirect,
  voiceEvalBrains,
  voiceEvalBrainWithoutQuickReply,
} from "../../fixtures/voice-eval/scriptedBrains.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
/**
 * A case on a test composition builds one per run, and a thank-you the composer answers (the
 * laneless brain, or a quick-reply-lane regression) waits out the scripted brains' 5 s
 * composing-idle bridge first; this lets either fail on its verdicts, not time out.
 */
const COMPOSITION_TURN_TIMEOUT_MS = 20_000;

const runCase = async (evalCase: ConversationQualityCase, port = createDeterministicVoiceTurnPort()) => {
  const { reports } = await runConversationQualitySuite([evalCase], port, {
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
 * The deterministic half of the voice eval cases (#1528), driven through a real
 * `VoiceTurnService` — the same policy, outcome derivation and lines production runs — instead
 * of a real model call. The searching and quick-reply cases run on a test composition's own
 * planner, retrieval and composer over a scripted model, so a turn that stops searching or leaves
 * the quick-reply lane fails;
 * the turn-limit and hand-off cases play a scripted chat backend. `tests/fixtures/voice-eval/`
 * holds the cases, the scripted models and the runner; `scripts/runEvals.ts` runs the cases a
 * live run can play nightly against the real brain.
 */
describe("voice conversation-quality cases", () => {
  it("bridges while the turn searches", async () => {
    const report = await runCase(caseNamed("voice-bridge-on-searching"));
    expect(report).toMatchObject({ status: "pass" });
  }, COMPOSITION_TURN_TIMEOUT_MS);

  it("answers a thank-you with no bridge", async () => {
    const report = await runCase(caseNamed("voice-quick-reply-no-bridge"));
    expect(report).toMatchObject({ status: "pass" });
  }, COMPOSITION_TURN_TIMEOUT_MS);

  it("falls back once the turn limit passes with nothing said", async () => {
    const report = await runCase(caseNamed("voice-turn-limit-fires"));
    expect(report).toMatchObject({ status: "pass" });
  });

  it("reports a callback outcome once a hand-off collects a slot", async () => {
    const report = await runCase(caseNamed("voice-outcome-handoff"));
    expect(report).toMatchObject({ status: "pass" });
  });

  it("fails the thank-you case when the composer answers it instead of the quick-reply lane", async () => {
    const lanelessPort = createDeterministicVoiceTurnPort({ "thanks-quick-reply": voiceEvalBrainWithoutQuickReply });

    const report = await runCase(caseNamed("voice-quick-reply-no-bridge"), lanelessPort);

    expect(report).toMatchObject({ status: "fail" });
    expect(report?.verdicts.filter((verdict) => verdict.status !== "pass").map((verdict) => verdict.assertion))
      .toEqual([{ type: "voice_bridge_emitted", expected: false }]);
  }, COMPOSITION_TURN_TIMEOUT_MS);

  it("fails the searching case when the planner answers directly instead of searching", async () => {
    const searchlessPort = createDeterministicVoiceTurnPort({ "searching-then-answer": voiceEvalBrainAnsweringDirect });

    const report = await runCase(caseNamed("voice-bridge-on-searching"), searchlessPort);

    expect(report).toMatchObject({ status: "fail" });
    expect(report?.verdicts.filter((verdict) => verdict.status !== "pass").map((verdict) => verdict.assertion))
      .toEqual([{ type: "voice_bridge_emitted", expected: true }]);
  }, COMPOSITION_TURN_TIMEOUT_MS);

  it("routes the searching case's planner to retrieval as the planner's own parser reads it, so the case runs the planner's retrieval path", () => {
    const plan = parseTurnPlan(scriptedPlanText({ route: "retrieval" }), { routineIds: [], directiveNames: new Set() });

    expect(plan?.route).toBe("retrieval");
  });

  it("drives each case from a scripted chat backend or a scripted model that exists", () => {
    const drivenBy = Object.fromEntries(voiceEvalCases.map((evalCase) => {
      const brain = evalCase.voiceTurn?.scriptedBrain;
      return [evalCase.id, brain === undefined ? "chat script" : `scripted model ${brain}`];
    }));

    expect(drivenBy).toEqual({
      "voice-bridge-on-searching": "scripted model searching-then-answer",
      "voice-quick-reply-no-bridge": "scripted model thanks-quick-reply",
      "voice-turn-limit-fires": "chat script",
      "voice-outcome-handoff": "chat script",
    });
    expect(Object.keys(voiceEvalBrains).sort()).toEqual(["searching-then-answer", "thanks-quick-reply"]);
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
