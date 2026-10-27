import { describe, expect, it } from "vitest";

import {
  attestableSteering,
  composeGroundedAnswerSystemPrompt,
} from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import { turnSkillUnavailableRule } from "../../src/modules/chat/services/turnSkillFallbackSteering.js";
import type { SteeringRule } from "../../src/shared/domain/steeringRule.js";

// The rule a fallback answer carries when a directive-bound skill could not run, as the
// real grounded answer prompt renders it next to the directive that bound the skill.
describe("turnSkillUnavailableRule in the grounded answer prompt", () => {
  const authored: SteeringRule = {
    id: "d1",
    directiveName: "order-status",
    action: "Use the order lookup for every order question.",
    priority: 100,
    source: "directive",
    lifespan: "response",
  };
  const unavailable = turnSkillUnavailableRule("order_lookup");
  const steering = [authored, unavailable];
  const { systemPrompt } = composeGroundedAnswerSystemPrompt({
    baseSystemPrompt: "You are a helpful assistant.",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    hasRetrievedContexts: true,
    conversationIntentSnapshot: { recentTurns: [] },
    steering,
  });

  it("names the tool that could not be consulted", () => {
    expect(unavailable.action).toContain('"order_lookup"');
  });

  it("renders once, ahead of the highest-priority authored directive it overrides", () => {
    expect(systemPrompt.split(unavailable.action)).toHaveLength(2);
    expect(systemPrompt.indexOf(unavailable.action)).toBeLessThan(systemPrompt.indexOf(authored.action));
  });

  it("renders without a rule id, so the answer is never asked to attest to it", () => {
    expect(systemPrompt).toContain(`- ${unavailable.action}`);
    expect(systemPrompt).toContain(`- [d1] ${authored.action}`);
    expect(attestableSteering(steering).flatMap((rule) => (rule.id ? [rule.id] : []))).toEqual(["d1"]);
  });

  it("stays out of the follow-up question block", () => {
    const suggestionBlock = systemPrompt.indexOf("Follow-up field rules");
    expect(suggestionBlock).toBeGreaterThan(systemPrompt.indexOf(unavailable.action));
    expect(systemPrompt.slice(suggestionBlock)).not.toContain(unavailable.action);
  });
});
