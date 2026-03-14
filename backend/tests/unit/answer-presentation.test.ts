import { describe, expect, it } from "vitest";

import { AnswerPresentationService } from "../../src/modules/chat/services/answerPresentationService.js";

describe("answer presentation service", () => {
  it("omits citation metadata when citation display is disabled", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Arudra is a leader.",
      citationDisplayEnabled: false,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Arudra",
          content: "Arudra is a leader.",
        },
      ],
    });

    expect(result).toEqual({
      answer: "Arudra is a leader.",
    });
  });

  it("assigns citations to matching clauses instead of appending all citations to the end", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "Arudra is a leader/facilitator featured by Ananda Europe, leads morning meditations and Purification ceremonies, and events are offered in Italian and English.",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Profile",
          content: "Arudra is a leader/facilitator featured by Ananda Europe.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Program",
          content: "Arudra leads morning meditations and Purification ceremonies.",
        },
        {
          documentId: "doc-3",
          chunkId: "chunk-3",
          title: "Languages",
          content: "Events are offered in Italian and English.",
        },
      ],
    });

    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Profile" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Program" },
      { documentId: "doc-3", chunkId: "chunk-3", title: "Languages" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Arudra is a leader/facilitator featured by Ananda Europe, ",
        citationIndices: [0],
      },
      {
        text: "leads morning meditations and Purification ceremonies, ",
        citationIndices: [1],
      },
      {
        text: "and events are offered in Italian and English.",
        citationIndices: [2],
      },
    ]);
  });

  it("collapses multiple chunks from the same document into one visible source", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Narayani's books are available from Ananda Edizioni.",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Narayani Anaya",
          content: "Narayani's books are available from Ananda Edizioni.",
        },
        {
          documentId: "doc-1",
          chunkId: "chunk-2",
          title: "Narayani Anaya",
          content: "The author page lists several books and bundles.",
        },
      ],
    });

    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Narayani Anaya" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Narayani's books are available from Ananda Edizioni.",
        citationIndices: [0],
      },
    ]);
  });

  it("does not insert citation boundaries inside prices or urls", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Author page: https://anandaedizioni.it/autore/narayani-anaya. Il mio cuore ricorda Swami Kriyananda costs EUR 18,00 today.",
      citationDisplayEnabled: true,
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Narayani Anaya",
          content: "Author page: https://anandaedizioni.it/autore/narayani-anaya.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Shop listing",
          content: "Il mio cuore ricorda Swami Kriyananda costs EUR 18,00 today.",
        },
      ],
    });

    expect(result.answerSegments).toEqual([
      {
        text: "Author page: https://anandaedizioni.it/autore/narayani-anaya. ",
        citationIndices: [0],
      },
      {
        text: "Il mio cuore ricorda Swami Kriyananda costs EUR 18,00 today.",
        citationIndices: [1],
      },
    ]);
  });
});
