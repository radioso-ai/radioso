import { describe, expect, it } from "vitest";

import { AnswerPresentationService } from "../../src/modules/chat/services/answerPresentationService.js";

describe("answer presentation service", () => {
  it("omits citation metadata when citation display is disabled", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Tomas is a leader.",
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

  it("requires explicit anchors for citation placement and does not fall back to heuristic segmentation", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "Tomas is a leader/facilitator featured by Valmora Europe, leads morning meditations and Purification ceremonies, and events are offered in Italian and English.",
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

    expect(result).toEqual({
      answer:
        "Tomas is a leader/facilitator featured by Valmora Europe, leads morning meditations and Purification ceremonies, and events are offered in Italian and English.",
    });
  });

  it("parses explicit anchors into deterministic segments and deduped citations", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Freya's books are available from Valmora Books.[[1]]",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Freya Rennick",
          content: "Freya's books are available from Valmora Books.",
        },
        {
          documentId: "doc-1",
          chunkId: "chunk-2",
          title: "Freya Rennick",
          content: "The author page lists several books and bundles.",
        },
      ],
    });

    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Freya Rennick" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Freya's books are available from Valmora Books.",
        citationIndices: [0],
      },
    ]);
  });

  it("removes anchors from the returned answer text", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Author page: https://books.valmora.example/autore/freya-rennick.[[1]] Price is EUR 18,00.[[2]]",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Freya Rennick",
          content: "Author page: https://books.valmora.example/autore/freya-rennick.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Shop listing",
          content: "Il mio cuore ricorda Swami Selan costs EUR 18,00 today.",
        },
      ],
    });

    expect(result.answer).toBe("Author page: https://books.valmora.example/autore/freya-rennick. Price is EUR 18,00.");
    expect(result.answerSegments).toEqual([
      {
        text: "Author page: https://books.valmora.example/autore/freya-rennick.",
        citationIndices: [0],
      },
      {
        text: " Price is EUR 18,00.",
        citationIndices: [1],
      },
    ]);
  });
});
