import { describe, expect, it } from "vitest";

import { ConversationExpansionComposer } from "../../src/modules/chat/services/conversationExpansionComposer.js";
import { ConversationExpansionPlanner } from "../../src/modules/chat/services/conversationExpansionPlanner.js";

const contexts = [
  {
    chunkId: "chunk-1",
    documentId: "doc-1",
    title: "Testing Guide",
    content: "The guide explains testing and parsing content for users.",
  },
  {
    chunkId: "chunk-2",
    documentId: "doc-2",
    title: "Parser Notes",
    content: "Parser notes cover validation rules and supported input formats.",
  },
  {
    chunkId: "chunk-3",
    documentId: "doc-3",
    title: "User FAQ",
    content: "The FAQ lists common user questions and onboarding tips.",
  },
];

describe("conversation mode composer", () => {
  it("plans focused guided continuations from grounded contexts", () => {
    const planner = new ConversationExpansionPlanner();

    const plan = planner.plan({
      conversationMode: "guided",
      brevityOverrideRequested: false,
      contexts,
      usedCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
    });

    expect(plan.applied).toBe(true);
    expect(plan.style).toBe("focused");
    expect(plan.suggestions).toHaveLength(2);
    expect(plan.followUpQuestion).toBeUndefined();
    expect(plan.suggestions.map((suggestion) => suggestion.title)).toEqual(["Parser Notes", "User FAQ"]);
  });

  it("suppresses expansion when the current turn explicitly asks for brevity", () => {
    const planner = new ConversationExpansionPlanner();

    const plan = planner.plan({
      conversationMode: "exploratory",
      brevityOverrideRequested: true,
      contexts,
      usedCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
    });

    expect(plan.applied).toBe(false);
    expect(plan.suggestions).toEqual([]);
    expect(plan.followUpQuestion).toBeUndefined();
  });

  it("composes exploratory expansion into a clearly separated grounded block", () => {
    const planner = new ConversationExpansionPlanner();
    const composer = new ConversationExpansionComposer();
    const plan = planner.plan({
      conversationMode: "exploratory",
      brevityOverrideRequested: false,
      contexts,
      usedCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
    });

    const composed = composer.compose({
      baseAnswer: "The guide explains testing and parsing content for users.",
      baseAnswerSegments: [{ text: "The guide explains testing and parsing content for users", citationIndices: [0] }, { text: "." }],
      visibleCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
      citationEvidence: contexts,
      citationDisplayEnabled: true,
      plan,
    });

    expect(composed.answer).toContain("Explore further:");
    expect(composed.answer).toContain("Parser Notes: Parser notes cover validation rules and supported input formats.");
    expect(composed.answer).toContain("User FAQ: The FAQ lists common user questions and onboarding tips.");
    expect(composed.answer).toContain("If helpful, I can compare Parser Notes and User FAQ next.");
    expect(composed.citations).toHaveLength(3);
    expect(composed.answerSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "The guide explains testing and parsing content for users",
          citationIndices: [0],
        }),
        expect.objectContaining({
          text: expect.stringContaining("Parser Notes: Parser notes cover validation rules and supported input formats."),
          citationIndices: [1],
        }),
        expect.objectContaining({
          text: expect.stringContaining("User FAQ: The FAQ lists common user questions and onboarding tips."),
          citationIndices: [2],
        }),
      ]),
    );
  });

  it("preserves uncited degraded text boundaries when adding exploratory suggestions", () => {
    const planner = new ConversationExpansionPlanner();
    const composer = new ConversationExpansionComposer();
    const plan = planner.plan({
      conversationMode: "exploratory",
      brevityOverrideRequested: false,
      contexts,
      usedCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
    });

    const composed = composer.compose({
      baseAnswer: "The guide explains testing and parsing content for users.\n\nI couldn't verify the rest.",
      baseAnswerSegments: [
        { text: "The guide explains testing and parsing content for users", citationIndices: [0] },
        { text: ".\n\n" },
        { text: "I couldn't verify the rest." },
      ],
      visibleCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
      citationEvidence: contexts,
      citationDisplayEnabled: true,
      plan,
    });

    expect(composed.answerSegments?.[2]).toEqual({ text: "I couldn't verify the rest." });
    expect(composed.answerSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Parser Notes: Parser notes cover validation rules and supported input formats."),
          citationIndices: [1],
        }),
      ]),
    );
  });

  it("excludes already used documents even when citations are hidden from the final answer", () => {
    const planner = new ConversationExpansionPlanner();

    const plan = planner.plan({
      conversationMode: "guided",
      brevityOverrideRequested: false,
      contexts,
      usedCitations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Testing Guide" }],
    });

    expect(plan.suggestions.map((suggestion) => suggestion.documentId)).toEqual(["doc-2", "doc-3"]);
  });
});
