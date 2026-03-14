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

  it("assigns citations to matching clauses instead of appending all citations to the end", () => {
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

    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Profile" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Program" },
      { documentId: "doc-3", chunkId: "chunk-3", title: "Languages" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Tomas is a leader/facilitator featured by Valmora Europe, ",
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
});
