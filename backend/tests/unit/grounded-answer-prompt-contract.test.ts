import { describe, expect, it } from "vitest";

import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { composeGroundedAnswerSystemPrompt } from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";

const conversationIntentSnapshot = {
  recentTurns: [],
  activeSubject: undefined,
  activeGoal: undefined,
  openQuestions: [],
};

describe("grounded answer prompt contract", () => {
  it("requires parseable source anchors for backend citation validation", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).toContain("[[1]]");
    expect(prompt).toMatch(/append a sourced assertion/i);
    expect(prompt).toMatch(/factual claim grounded/i);
    expect(prompt).not.toMatch(/do not write citation markers/i);
    expect(prompt).not.toMatch(/application attaches source citations after generation/i);
    expect(prompt).toContain("[[?]]");
  });

  it("states the source-anchor authoring rule once, in the base prompt, not the envelope", () => {
    const base = loadPromptTemplate("retrieval/answer.md");
    const envelope = loadPromptTemplate("chat/answer-envelope.md");

    // The detailed [[n]]/[[?]] authoring rule is owned by the base prompt's Citations section.
    expect(base).toMatch(/append a sourced assertion/i);
    // The envelope must not duplicate that authoring rule; it only references it.
    expect(envelope).not.toMatch(/append a sourced assertion/i);
    expect(envelope).toMatch(/as the Citations rule above requires/i);

    // Fields the strict provider schema already locks must not be re-stated as prose.
    expect(envelope).not.toMatch(/set `?v`? to/i);
    expect(envelope).not.toMatch(/always emit .*grounding/i);
  });

  it("always appends the v2 core and only appends suggestion policy when enabled", () => {
    const disabled = composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: "BASE",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      hasRetrievedContexts: true,
      conversationIntentSnapshot,
    });
    const enabled = composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: "BASE",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      hasRetrievedContexts: true,
      conversationIntentSnapshot,
    });

    for (const result of [disabled, enabled]) {
      expect(result.systemPrompt).toContain("Return exactly the JSON object required by the provider response schema");
      expect(result.systemPrompt).toContain('"answer":');
      expect(result.systemPrompt).toContain('"v":2');
      expect(result.systemPrompt).toContain('"outcome":"answer"');
      expect(result.systemPrompt).toContain('"outcome":"no_support"');
      expect(result.systemPrompt).toContain('"grounding":"degraded"');
    }
    expect(disabled.suggestionsExpected).toBe(false);
    expect(disabled.systemPrompt).not.toContain("Suggestion quality");
    expect(enabled.suggestionsExpected).toBe(true);
    expect(enabled.systemPrompt).toContain("Output envelope");
    expect(enabled.systemPrompt).toContain("Suggestion quality");
    expect(enabled.systemPrompt).not.toContain("<<<RADIOSO_FOLLOWUPS_JSON>>>");
  });

  it("shows enabled suggestions only inside a non-empty v2 envelope", () => {
    const enabled = composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: "BASE",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      hasRetrievedContexts: true,
      conversationIntentSnapshot,
    });

    expect(enabled.systemPrompt).toContain(
      '"suggestions":[{"text":"How does the practice begin?","kind":"deeper","contextIndex":1}]',
    );
    expect(enabled.systemPrompt).toContain(
      "never appended to the visible markdown body",
    );
    expect(enabled.systemPrompt).not.toContain("\nSuggestions\n");
  });

  it("renders conversation-intent context inside the conditional suggestion block", () => {
    const enabled = composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: "BASE",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      hasRetrievedContexts: true,
      conversationIntentSnapshot: {
        recentTurns: [{ role: "user", content: "Help me plan a retreat" }],
        activeSubject: "Facilitator support",
        activeGoal: "Plan the next retreat",
      },
    });

    expect(enabled.systemPrompt).toContain("Recent conversation context:");
    expect(enabled.systemPrompt).toContain("Help me plan a retreat");
    expect(enabled.systemPrompt).toContain("Active subject:\nFacilitator support");
    expect(enabled.systemPrompt).toContain("Active goal:\nPlan the next retreat");
  });

  it("renders the canonical decline rules in main retrieval and focused miss prompts", () => {
    const main = new PromptBuilder().build({
      query: "What?",
      history: [],
      contexts: [],
      settings: {},
    }).systemPrompt;
    const focused = loadPromptTemplate("chat/grounded-miss.md");
    const canonicalSentence = "Never answer from general knowledge when support is absent.";

    expect(main).toContain(canonicalSentence);
    expect(focused).toContain("{{decline_rules}}");
    expect(loadPromptTemplate("chat/grounded-decline-rules.md")).toContain(canonicalSentence);
  });

  it("decides answer support from retrieved findings rather than question wording or instructions", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).toContain("The presence or absence of supporting findings decides whether the question can be answered");
    expect(prompt).toContain("never infer support from the wording of the question or from configured answer instructions");
    expect(prompt).not.toContain("Outside-scope subrequests include");
  });

  it("keeps the protocol assets within their locked word budgets", () => {
    const countWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;
    // Tightened in #863: the #903 provider schema enforces the field set and the
    // v/outcome/kind/grounding value sets, so the envelope no longer restates them.
    expect(countWords(loadPromptTemplate("chat/answer-envelope.md"))).toBeGreaterThanOrEqual(200);
    expect(countWords(loadPromptTemplate("chat/answer-envelope.md"))).toBeLessThanOrEqual(260);
    expect(countWords(loadPromptTemplate("chat/answer-suggestions.md"))).toBeGreaterThanOrEqual(560);
    expect(countWords(loadPromptTemplate("chat/answer-suggestions.md"))).toBeLessThanOrEqual(650);
    expect(countWords(loadPromptTemplate("retrieval/answer.md")) + countWords(loadPromptTemplate("chat/grounded-decline-rules.md"))).toBeGreaterThanOrEqual(760);
    expect(countWords(loadPromptTemplate("retrieval/answer.md")) + countWords(loadPromptTemplate("chat/grounded-decline-rules.md"))).toBeLessThanOrEqual(850);
    expect(countWords(loadPromptTemplate("chat/grounded-miss.md")) + countWords(loadPromptTemplate("chat/grounded-decline-rules.md"))).toBeGreaterThanOrEqual(300);
    expect(countWords(loadPromptTemplate("chat/grounded-miss.md")) + countWords(loadPromptTemplate("chat/grounded-decline-rules.md"))).toBeLessThanOrEqual(380);
  });

  it("keeps reusable answer behavior out of the base prompt so directives own it", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).not.toContain("You are representing the organization");
    expect(prompt).not.toContain("Embed inline Markdown links directly in the answer");
    expect(prompt).not.toContain("Provide ample links");
  });

  it("limits inline links to named resources with explicit Source URLs", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).toContain("has such a Source URL");
    expect(prompt).toContain("turn that resource's own name into an inline Markdown link to its Source URL");
    expect(prompt).toContain("Never invent a URL");
    expect(prompt).not.toContain("source you draw the answer from");
    expect(prompt).not.toContain("leaving only a bare citation marker");
  });
});
