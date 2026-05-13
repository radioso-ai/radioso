import { describe, expect, it } from "vitest";

import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";

describe("AssistantSuggestionExpansionService", () => {
  it("keeps retrieved context available while instructing suggestions not to reveal hidden specifics", async () => {
    let capturedPrompt = "";
    const service = new AssistantSuggestionExpansionService(async ({ prompt }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        suggestions: [
          { text: "What suitable options are available?", kind: "deeper", contextIndex: 2 },
          { text: "How can yoga help daily life?", kind: "broader", contextIndex: 1 },
        ],
      });
    });

    const result = await service.apply({
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
      history: [],
      conversationIntentSnapshot: {
        recentTurns: [],
        activeSubject: "yoga",
        activeGoal: "Tell me about yoga",
      },
    });

    expect(capturedPrompt).toContain("John practices yoga");
    expect(capturedPrompt).toContain("Candidate contexts may inspire broad themes");
    expect(capturedPrompt).toContain("Do not reveal proper names");
    expect(capturedPrompt).toContain("If the answer offers a next step");
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
});
