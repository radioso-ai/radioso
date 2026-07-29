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
  it("shows searchable author metadata to the answer model", () => {
    const result = new PromptBuilder().build({
      query: "Who is Mario Liguori?",
      history: [],
      contexts: [
        {
          chunkId: "chunk-1",
          documentId: "document-1",
          title: "Who Was Swamiji, Really?",
          content: "The article body does not repeat the author byline.",
          similarity: 0.9,
          retrievalSources: ["lexical"],
          retrievalText: "Author: Mario Liguori",
          semanticScore: 0.7,
          lexicalScore: 0.9,
          relevanceScore: 0.9,
          rerankPosition: 1,
          promptPosition: 1,
          estimatedTokenCost: 24,
          metadata: {
            author: "Mario Liguori",
            sourceUrl: "https://example.com/who-was-swamiji",
          },
        },
      ],
      settings: {},
    });

    expect(result.prompt).toContain("Author: Mario Liguori");
  });

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
      expect(result.systemPrompt).toContain('"outcome":"out_of_scope"');
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

  it("scopes decline rules by turn type: compact inline guard on grounded, full rules on focused miss", () => {
    const main = new PromptBuilder().build({
      query: "What?",
      history: [],
      contexts: [],
      settings: {},
    }).systemPrompt;
    const inline = loadPromptTemplate("chat/grounded-inline-decline.md");
    const focused = loadPromptTemplate("chat/grounded-miss.md");
    const fullRules = loadPromptTemplate("chat/grounded-decline-rules.md");

    // The grounded answer prompt (#863) folds in the compact inline-decline guard,
    // not the full focused-miss ruleset. It keeps the guard-case essentials.
    expect(main).toContain("Never answer from general knowledge when support is absent");
    expect(main).toContain(inline.split("\n")[0]);
    expect(main).not.toContain("{{decline_rules}}");
    // The full focused-miss elaborations must not ride on every grounded answer turn.
    expect(main).not.toContain("give no solution, explanation, summary, translation, calculation, result, formula, code, facts, draft, or reasoning");

    // The focused-miss path still folds in the full canonical decline ruleset.
    expect(focused).toContain("{{decline_rules}}");
    expect(fullRules).toContain("Never answer from general knowledge when support is absent");
    expect(fullRules).toContain("draft, or reasoning");

    // The compact inline guard preserves the guard-case protections that live
    // declines regress on: no outside knowledge, no internals leakage, no librarian
    // phrasing, team voice, and distress warmth.
    expect(inline).toMatch(/team's first-person voice/i);
    expect(inline).toMatch(/librarian phrasing/i);
    expect(inline).toMatch(/documents, sources, search, retrieval, Result labels/i);
    expect(inline).toMatch(/distress/i);
  });

  it("decides answer support from retrieved findings rather than question wording or instructions", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).toContain("The presence or absence of supporting findings decides whether the question can be answered");
    expect(prompt).toContain("never infer support from the wording of the question or from configured answer instructions");
    expect(prompt).not.toContain("Outside-scope subrequests include");
  });

  it("separates the two declines in both decline-producing prompts", () => {
    const envelope = loadPromptTemplate("chat/answer-envelope.md");
    const focused = loadPromptTemplate("chat/grounded-miss.md");

    // The envelope owns the inline decline; it must offer both values and default
    // to the conservative one so an unclassifiable decline still counts against us.
    expect(envelope).toContain("`out_of_scope`");
    expect(envelope).toContain("`no_support`");
    expect(envelope).toMatch(/when unsure/i);

    // The focused-miss prompt now returns a JSON object, not bare text.
    expect(focused).toContain("declineReason");
    expect(focused).toContain("content_gap");
    expect(focused).toContain("out_of_scope");
    expect(focused).not.toContain("Return only the response text");
    // Scope is judged against configuration, never against the language of the question.
    expect(focused).toMatch(/configured answer instructions/i);
  });

  it("keeps the protocol assets within their locked word budgets", () => {
    const countWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;
    // Tightened in #863: the #903 provider schema enforces the field set and the
    // v/outcome/kind/grounding value sets, so the envelope no longer restates them.
    expect(countWords(loadPromptTemplate("chat/answer-envelope.md"))).toBeGreaterThanOrEqual(200);
    // Widened in #946: the envelope now distinguishes the two declines and carries an
    // out-of-scope example alongside the miss example.
    expect(countWords(loadPromptTemplate("chat/answer-envelope.md"))).toBeLessThanOrEqual(290);
    expect(countWords(loadPromptTemplate("chat/answer-suggestions.md"))).toBeGreaterThanOrEqual(560);
    // Tightened in #863: the strict provider schema hard-enforces the item field
    // set (additionalProperties:false + required) and JSON-only output, so the
    // "compact object with only …" / "no commentary outside the JSON" prose is gone.
    expect(countWords(loadPromptTemplate("chat/answer-suggestions.md"))).toBeLessThanOrEqual(640);
    // The grounded answer base folds in the compact inline-decline guard (#863),
    // not the full focused-miss ruleset.
    expect(countWords(loadPromptTemplate("retrieval/answer.md")) + countWords(loadPromptTemplate("chat/grounded-inline-decline.md"))).toBeGreaterThanOrEqual(690);
    expect(countWords(loadPromptTemplate("retrieval/answer.md")) + countWords(loadPromptTemplate("chat/grounded-inline-decline.md"))).toBeLessThanOrEqual(760);
    expect(countWords(loadPromptTemplate("chat/grounded-miss.md")) + countWords(loadPromptTemplate("chat/grounded-decline-rules.md"))).toBeGreaterThanOrEqual(300);
    // Widened in #946: the focused decline also returns a decline classification.
    expect(countWords(loadPromptTemplate("chat/grounded-miss.md")) + countWords(loadPromptTemplate("chat/grounded-decline-rules.md"))).toBeLessThanOrEqual(460);
  });

  it("budgets the composed instruction sheet per turn type (#863)", () => {
    // #863 asks for a per-turn-type instruction budget so guard-creep on one turn
    // type is caught without re-inspecting every prompt. Each entry is the composed
    // template stack a turn type actually ships (base folds {{decline_rules}} in).
    const countWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;
    const stack = (...files: string[]) =>
      files.reduce((total, file) => total + countWords(loadPromptTemplate(file)), 0);

    // Grounded answer, suggestions enabled — the hottest and heaviest sheet. It folds
    // in the compact inline-decline guard (#863), not the full focused-miss ruleset.
    const groundedWithSuggestions = stack(
      "retrieval/answer.md",
      "chat/grounded-inline-decline.md",
      "chat/answer-envelope.md",
      "chat/answer-suggestions.md",
    );
    expect(groundedWithSuggestions).toBeGreaterThanOrEqual(1450);
    expect(groundedWithSuggestions).toBeLessThanOrEqual(1650);

    // Grounded answer, suggestions disabled.
    const groundedNoSuggestions = stack(
      "retrieval/answer.md",
      "chat/grounded-inline-decline.md",
      "chat/answer-envelope.md",
    );
    expect(groundedNoSuggestions).toBeGreaterThanOrEqual(900);
    expect(groundedNoSuggestions).toBeLessThanOrEqual(1020);

    // Focused decline / grounded-miss owns the full decline ruleset.
    const focusedDecline = stack("chat/grounded-miss.md", "chat/grounded-decline-rules.md");
    expect(focusedDecline).toBeGreaterThanOrEqual(300);
    expect(focusedDecline).toBeLessThanOrEqual(460);

    // Clarification and direct/non-retrieval turns each stay lean and, by AC,
    // carry no citation/link/suggestion authoring rules.
    expect(stack("chat/clarification-question.md")).toBeLessThanOrEqual(130);
    expect(stack("chat/non-retrieval-answer.md")).toBeLessThanOrEqual(700);
    for (const file of ["chat/clarification-question.md", "chat/non-retrieval-answer.md", "chat/grounded-miss.md"]) {
      const template = loadPromptTemplate(file);
      expect(template).not.toMatch(/append a sourced assertion/i);
      expect(template).not.toMatch(/\[\[1\]\]/);
      expect(template).not.toMatch(/Source URL/i);
    }
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
