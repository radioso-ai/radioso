import { describe, expect, it } from "vitest";

import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";

const stubExpansion = {
  apply() {
    return { suggestions: [] as ChatSuggestion[] };
  },
} as unknown as AssistantSuggestionExpansionService;

const presenter = new ChatAnswerPresenter(stubExpansion);

describe("ChatAnswerPresenter.presentRoutineAnswer", () => {
  it("attaches citations from routine retrieval evidence and resolves the source url", () => {
    const result = presenter.presentRoutineAnswer("Kriya is introduced in the first module[[1]].", [
      {
        documentId: "doc_1",
        chunkId: "chunk_1",
        title: "Course Guide",
        content: "Kriya is introduced in the first module.",
        metadata: { sourceUrl: "https://example.com/guide" },
      },
    ]);

    expect(result.citations).toEqual([
      {
        documentId: "doc_1",
        chunkId: "chunk_1",
        title: "Course Guide",
        sourceUrl: "https://example.com/guide",
      },
    ]);
  });

  it("falls back to non-retrieval behavior when there are no citations", () => {
    const result = presenter.presentRoutineAnswer("Thanks, glad to help!", []);
    const baseline = presenter.presentNonRetrievalAnswer("Thanks, glad to help!");

    expect(result.citations ?? []).toHaveLength(0);
    expect(result.planningCitations).toEqual([]);
    expect(result.answerOutcome).toBe(baseline.answerOutcome);
  });

  it("drops an unsafe (non-http) source url while keeping the citation", () => {
    const result = presenter.presentRoutineAnswer("See the linked guide[[1]].", [
      {
        documentId: "doc_2",
        chunkId: "chunk_2",
        title: "Guide",
        content: "See the linked guide.",
        metadata: { sourceUrl: "javascript:alert(1)" },
      },
    ]);

    expect(result.citations).toEqual([
      {
        documentId: "doc_2",
        chunkId: "chunk_2",
        title: "Guide",
      },
    ]);
  });

  it("ignores non-citation junk in the citations array", () => {
    const result = presenter.presentRoutineAnswer("Hello there.", [null, 42, { notACitation: true }]);
    expect(result.citations ?? []).toHaveLength(0);
  });

  it("does not attach routine evidence without an explicit anchor", () => {
    const result = presenter.presentRoutineAnswer("Kriya is introduced in the first module.", [
      { documentId: "doc_1", chunkId: "chunk_1", title: "Course Guide", content: "Kriya is introduced." },
    ]);
    expect(result.citations ?? []).toEqual([]);
  });
});
