import { describe, expect, it } from "vitest";

import {
  attestableSteering,
  composeGroundedAnswerSystemPrompt,
} from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import type { SteeringRule } from "../../src/shared/domain/steeringRule.js";

const withSuggestions = {
  baseSystemPrompt: "You are a helpful assistant.",
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  hasRetrievedContexts: true,
  conversationIntentSnapshot: { recentTurns: [] },
};

const answerRule: SteeringRule = {
  action: "Speak as the organization.",
  source: "directive",
  lifespan: "response",
};

const suggestionRule: SteeringRule = {
  action: "Never suggest a follow-up question about price.",
  source: "directive",
  lifespan: "response",
  surfaces: ["suggested_questions"],
};

const suggestionBlockOf = (prompt: string): string => {
  const index = prompt.indexOf("Follow-up field rules");
  expect(index).toBeGreaterThan(-1);
  return prompt.slice(index);
};

describe("composeGroundedAnswerSystemPrompt — generation surface scope", () => {
  it("keeps an unscoped rule on the answer body and off the suggestion block", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      steering: [answerRule],
    });

    expect(systemPrompt).toContain("Speak as the organization.");
    expect(suggestionBlockOf(systemPrompt)).not.toContain("Speak as the organization.");
  });

  it("renders a suggestion-scoped rule inside the suggestion block, not the answer steering", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      steering: [suggestionRule],
    });

    const suggestionBlock = suggestionBlockOf(systemPrompt);
    expect(suggestionBlock).toContain("Never suggest a follow-up question about price.");
    expect(systemPrompt.slice(0, systemPrompt.indexOf("Follow-up field rules"))).not.toContain(
      "Never suggest a follow-up question about price.",
    );
  });

  it("drops a suggestion-scoped rule entirely when suggestions are off", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      steering: [suggestionRule],
    });

    expect(systemPrompt).not.toContain("Never suggest a follow-up question about price.");
  });

  it("renders a rule scoped to both surfaces in both places", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      steering: [{ ...suggestionRule, surfaces: ["answer", "suggested_questions"] }],
    });

    const split = systemPrompt.indexOf("Follow-up field rules");
    expect(systemPrompt.slice(0, split)).toContain("Never suggest a follow-up question about price.");
    expect(systemPrompt.slice(split)).toContain("Never suggest a follow-up question about price.");
  });

  it("leaves the suggestion block unchanged when no rule addresses it", () => {
    const scoped = composeGroundedAnswerSystemPrompt({ ...withSuggestions, steering: [answerRule] });
    const none = composeGroundedAnswerSystemPrompt({ ...withSuggestions, steering: [] });

    expect(suggestionBlockOf(scoped.systemPrompt)).toBe(suggestionBlockOf(none.systemPrompt));
  });
});

describe("composeGroundedAnswerSystemPrompt — surface isolation", () => {
  // The two blocks share one system prompt, so isolation is a claim the prompt has to
  // make in words. A model reading "follow these when forming your response" would
  // apply an answer rule to the suggestions array too, which is the contract the
  // surface scope exists to keep. The behavior itself is covered by the eval suite;
  // this pins the clauses that carry it.
  it("scopes the answer directives to the answer text rather than the whole response", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      steering: [answerRule],
    });

    expect(systemPrompt).toContain("govern the visible answer you write");
    expect(systemPrompt).toContain("Their reach is the answer text.");
    expect(systemPrompt).not.toContain("Follow them when forming your response");
  });

  it("tells the suggestion generator that answer directives have no say over it", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      steering: [answerRule],
    });

    const suggestionBlock = suggestionBlockOf(systemPrompt);
    expect(suggestionBlock).toContain("Only directives in this section govern what you may suggest");
    // Stated once, from the answer side, where it only renders when directives exist.
    expect(systemPrompt).toContain("Their reach is the answer text.");
    expect(systemPrompt).toContain("governed by their own directives stated with the suggestion rules");
  });

  it("states the isolation even when no directive addresses the suggestion generator", () => {
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...withSuggestions,
      steering: [],
    });

    // The common case: nothing is scoped to suggestions, so the optional steering
    // block is empty and the standing rules have to carry the isolation alone.
    expect(suggestionBlockOf(systemPrompt)).toContain(
      "Only directives in this section govern what you may suggest",
    );
  });
});

describe("attestableSteering", () => {
  const withId = (rule: SteeringRule, id: string): SteeringRule => ({ ...rule, id });

  it("keeps rules the answer block renders with ids", () => {
    const rule = withId(answerRule, "d1");

    expect(attestableSteering([rule])).toEqual([rule]);
  });

  it("drops a rule addressed only to the suggestion generator, which renders no ids", () => {
    expect(attestableSteering([withId(suggestionRule, "d2")])).toEqual([]);
  });

  it("keeps a rule addressed to both, because the answer block still renders it", () => {
    const rule = withId({ ...suggestionRule, surfaces: ["answer", "suggested_questions"] }, "d3");

    expect(attestableSteering([rule])).toEqual([rule]);
  });

  it("is empty for an empty set", () => {
    expect(attestableSteering()).toEqual([]);
  });
});
