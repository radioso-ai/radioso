import { describe, expect, it } from "vitest";

import { AnswerPresentationService } from "../../src/modules/chat/services/answerPresentationService.js";

describe("answer presentation service", () => {
  it("retains normalized segments and citation evidence for validation even when citation display is disabled", () => {
    const service = new AnswerPresentationService();

    const normalized = service.normalize({
      answer: "Tomas is a leader[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Tomas",
          content: "Tomas is a leader.",
        },
      ],
    });

    expect(normalized).toEqual({
      answer: "Tomas is a leader.",
      citationEvidence: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Tomas",
          content: "Tomas is a leader.",
        },
      ],
      answerSegments: [
        {
          text: "Tomas is a leader",
          citationIndices: [0],
        },
        {
          text: ".",
        },
      ],
    });
    expect(
      service.present({
        answer: "Tomas is a leader[[1]].",
        citationDisplayEnabled: false,
        citations: [
          {
            documentId: "doc-1",
            chunkId: "chunk-1",
            title: "Tomas",
            content: "Tomas is a leader.",
          },
        ],
      }),
    ).toEqual({
      answer: "Tomas is a leader.",
    });
  });

  it("strips raw citation anchors when citation display is disabled", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Tomas is a leader[[1]].",
      citationDisplayEnabled: false,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Tomas",
          content: "Tomas is a leader.",
        },
      ],
    });

    expect(result).toEqual({
      answer: "Tomas is a leader.",
    });
  });

  it("uses explicit anchors for exact citation placement", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "Tomas is a leader/facilitator featured by Valmora Europe[[1]], leads morning meditations and Purification ceremonies[[2]], and events are offered in Italian and English[[3]].",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Profile",
          content: "Tomas is a leader/facilitator featured by Valmora Europe.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Program",
          content: "Tomas leads morning meditations and Purification ceremonies.",
        },
        {
          documentId: "doc-3",
          chunkId: "chunk-3",
          title: "Languages",
          content: "Events are offered in Italian and English.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Tomas is a leader/facilitator featured by Valmora Europe, leads morning meditations and Purification ceremonies, and events are offered in Italian and English.",
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Profile" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Program" },
      { documentId: "doc-3", chunkId: "chunk-3", title: "Languages" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Tomas is a leader/facilitator featured by Valmora Europe",
        citationIndices: [0],
      },
      {
        text: ", leads morning meditations and Purification ceremonies",
        citationIndices: [1],
      },
      {
        text: ", and events are offered in Italian and English",
        citationIndices: [2],
      },
      {
        text: ".",
      },
    ]);
  });

  it("keeps only the first valid cited result at a claim boundary", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Freya's books are available from Valmora Books[[1]][[2]].",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Freya Rennick",
          content: "Freya's books are available from Valmora Books.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Valmora Books",
          content: "The author page lists several books and bundles.",
        },
      ],
    });

    expect(result.answer).toBe("Freya's books are available from Valmora Books.");
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Freya Rennick" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Freya's books are available from Valmora Books",
        citationIndices: [0],
      },
      {
        text: ".",
      },
    ]);
  });

  it("falls through to the next valid anchor when the first cited result is invalid", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "The retreat is offered in Montelago[[9]][[2]].",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Placeholder",
          content: "Unused context.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Retreat Calendar",
          content: "The retreat is offered in Montelago.",
        },
      ],
    });

    expect(result.answer).toBe("The retreat is offered in Montelago.");
    expect(result.citations).toEqual([
      { documentId: "doc-2", chunkId: "chunk-2", title: "Retreat Calendar" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "The retreat is offered in Montelago",
        citationIndices: [0],
      },
      {
        text: ".",
      },
    ]);
  });

  it("drops invalid anchors and removes malformed placeholder syntax from the final answer", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Author page: https://books.valmora.example/autore/freya-rennick[[1]]. Price: EUR 18,00[[9]]. Broken [[abc]] token and dangling [[ marker.",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Freya Rennick",
          content: "Author page: https://books.valmora.example/autore/freya-rennick.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Author page: https://books.valmora.example/autore/freya-rennick. Price: EUR 18,00. Broken  token and dangling  marker.",
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Freya Rennick" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Author page: https://books.valmora.example/autore/freya-rennick",
        citationIndices: [0],
      },
      {
        text: ". Price: EUR 18,00. Broken  token and dangling  marker.",
      },
    ]);
  });

  it("collapses consecutive claims that cite the same document into one visible citation", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Tomas leads morning meditations[[1]]. He also leads Purification ceremonies[[1]].",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Program",
          content: "Tomas leads morning meditations and Purification ceremonies.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Tomas leads morning meditations. He also leads Purification ceremonies.",
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Program" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Tomas leads morning meditations. He also leads Purification ceremonies",
        citationIndices: [0],
      },
      {
        text: ".",
      },
    ]);
  });

  it("keeps separate citation markers when the same source spans multiple paragraphs", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "First grounded paragraph[[1]].\n\nSecond grounded paragraph[[1]].",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Guide",
          content: "First grounded paragraph. Second grounded paragraph.",
        },
      ],
    });

    expect(result.answerSegments).toEqual([
      {
        text: "First grounded paragraph",
        citationIndices: [0],
      },
      {
        text: ".\n\nSecond grounded paragraph",
        citationIndices: [0],
      },
      {
        text: ".",
      },
    ]);
  });
});
