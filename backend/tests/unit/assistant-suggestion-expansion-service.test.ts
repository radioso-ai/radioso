import { describe, expect, it } from "vitest";

import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";

describe("AssistantSuggestionExpansionService", () => {
  const service = new AssistantSuggestionExpansionService();

  const baseInput = {
    query: "Tell me about yoga",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 2,
    groundedAnswerSupported: true,
    answer: "Yoga can support steady practice and daily well-being.",
    contexts: [
      {
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "Private practitioner note",
        content: "John practices yoga with breathing routines.",
      },
      {
        documentId: "doc-2",
        chunkId: "chunk-2",
        title: "Course catalog",
        content: "The catalog lists suitable beginner options for yoga.",
      },
    ],
  };

  it("validates and attaches citation evidence to planned suggestions", () => {
    const result = service.apply({
      ...baseInput,
      plannedSuggestions: [
        { text: "What suitable options are available?", kind: "deeper", contextIndex: 2 },
        { text: "How can yoga help daily life?", kind: "broader", contextIndex: 1 },
      ],
    });

    expect(result.suggestions).toEqual([
      expect.objectContaining({
        text: "What suitable options are available?",
        kind: "deeper",
        citation: expect.objectContaining({ documentId: "doc-2" }),
      }),
      expect.objectContaining({
        text: "How can yoga help daily life?",
        kind: "broader",
        citation: expect.objectContaining({ documentId: "doc-1" }),
      }),
    ]);
  });

  it("returns empty when no planned suggestions are provided", () => {
    const result = service.apply({ ...baseInput, plannedSuggestions: [] });
    expect(result.suggestions).toBeUndefined();
  });

  it("skips suggestions whose contextIndex does not map to a context", () => {
    const result = service.apply({
      ...baseInput,
      plannedSuggestions: [
        { text: "Which retreats fit the schedule?", kind: "deeper", contextIndex: 99 },
        { text: "Which beginner courses welcome newcomers?", kind: "deeper", contextIndex: 2 },
      ],
    });

    expect(result.suggestions).toEqual([
      expect.objectContaining({ text: "Which beginner courses welcome newcomers?" }),
    ]);
  });

  it("drops near-duplicates of the original query or answer", () => {
    const result = service.apply({
      ...baseInput,
      plannedSuggestions: [
        { text: "Tell me about yoga", kind: "deeper", contextIndex: 1 },
        { text: "Which beginner options would suit me?", kind: "deeper", contextIndex: 2 },
      ],
    });

    expect(result.suggestions).toEqual([
      expect.objectContaining({ text: "Which beginner options would suit me?" }),
    ]);
  });

  it("caps suggestions at suggestedQuestionsCount while preserving deeper/broader balance", () => {
    const result = service.apply({
      ...baseInput,
      suggestedQuestionsCount: 2,
      plannedSuggestions: [
        { text: "What rules apply at the studio?", kind: "deeper", contextIndex: 1 },
        { text: "What instructors are available?", kind: "deeper", contextIndex: 2 },
        { text: "How does yoga compare to pilates?", kind: "broader", contextIndex: 2 },
        { text: "What schedule options exist?", kind: "broader", contextIndex: 1 },
      ],
    });

    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions?.some((s) => s.kind === "deeper")).toBe(true);
    expect(result.suggestions?.some((s) => s.kind === "broader")).toBe(true);
  });

  it("returns nothing when grounded answer is not supported", () => {
    const result = service.apply({
      ...baseInput,
      groundedAnswerSupported: false,
      plannedSuggestions: [
        { text: "Some valid follow-up question?", kind: "deeper", contextIndex: 1 },
      ],
    });

    expect(result.suggestions).toBeUndefined();
  });

  it("returns nothing when suggestions are disabled", () => {
    const result = service.apply({
      ...baseInput,
      suggestedQuestionsEnabled: false,
      plannedSuggestions: [
        { text: "Some valid follow-up question?", kind: "deeper", contextIndex: 1 },
      ],
    });

    expect(result.suggestions).toBeUndefined();
  });
});
