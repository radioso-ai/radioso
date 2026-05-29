import { describe, expect, it } from "vitest";

import { composeGroundedAnswerSystemPrompt } from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import type { SteeringRule } from "../../src/shared/domain/steeringRule.js";

const baseInput = {
  baseSystemPrompt: "You are a helpful assistant.",
  suggestedQuestionsEnabled: false,
  suggestedQuestionsCount: 0,
  hasRetrievedContexts: false,
  conversationIntentSnapshot: { recentTurns: [] },
};

describe("composeGroundedAnswerSystemPrompt — directive steering", () => {
  it("is behavior-preserving when no steering rules are supplied", () => {
    const without = composeGroundedAnswerSystemPrompt(baseInput);
    const withEmpty = composeGroundedAnswerSystemPrompt({ ...baseInput, steering: [] });
    expect(withEmpty.systemPrompt).toBe(without.systemPrompt);
    expect(withEmpty.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("renders matched directive actions into the system prompt", () => {
    const steering: SteeringRule[] = [
      { action: "slow down and confirm before acting", criticality: "high", source: "directive", lifespan: "response" },
      { action: "prefer concrete examples", source: "directive", lifespan: "response" },
    ];
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({ ...baseInput, steering });

    expect(systemPrompt).toContain("You are a helpful assistant.");
    expect(systemPrompt).toContain("slow down and confirm before acting");
    expect(systemPrompt).toContain("prefer concrete examples");
  });
});
