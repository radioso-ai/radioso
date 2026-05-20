import { describe, expect, it } from "vitest";

import { attachImplicitCitationArtifacts } from "../../src/modules/chat/services/implicitCitationSupport.js";
import type { CitationEvidence } from "../../src/modules/chat/contracts/answerTypes.js";

const citations: CitationEvidence[] = [
  {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Meditation Tips",
    content: "Keep meditation practice short and simple. Begin with a few minutes each day.",
  },
  {
    documentId: "doc-2",
    chunkId: "chunk-2",
    title: "Course Schedule",
    content: "Residential course registration opens in March and closes in May.",
  },
];

describe("implicit citation support", () => {
  it("attaches different citations to clean prose sentences from different sources", () => {
    const result = attachImplicitCitationArtifacts(
      [
        {
          text: "Keep meditation practice short and simple. Residential course registration opens in March.",
        },
      ],
      citations,
    );

    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Course Schedule" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Keep meditation practice short and simple. ",
        citationIndices: [0],
      },
      {
        text: "Residential course registration opens in March.",
        citationIndices: [1],
      },
    ]);
  });

  it("leaves mixed unsupported clean prose uncited when validation is disabled", () => {
    const result = attachImplicitCitationArtifacts(
      [
        {
          text: "Keep meditation practice short and simple. Phone support is available 24/7.",
        },
      ],
      citations,
    );

    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Keep meditation practice short and simple. ",
        citationIndices: [0],
      },
      {
        text: "Phone support is available 24/7.",
      },
    ]);
  });

  it("does not over-attach citations to short generic answers", () => {
    const result = attachImplicitCitationArtifacts(
      [
        {
          text: "Yes, we offer that.",
        },
      ],
      citations,
    );

    expect(result.citations).toEqual([]);
    expect(result.answerSegments).toEqual([{ text: "Yes, we offer that." }]);
  });

  it("does not attach citations when overlap is ambiguous between sources", () => {
    const result = attachImplicitCitationArtifacts(
      [
        {
          text: "Alpha beta gamma delta.",
        },
      ],
      [
        {
          documentId: "doc-alpha",
          chunkId: "chunk-alpha",
          title: "First",
          content: "Alpha beta.",
        },
        {
          documentId: "doc-beta",
          chunkId: "chunk-beta",
          title: "Second",
          content: "Alpha gamma.",
        },
      ],
    );

    expect(result.citations).toEqual([]);
    expect(result.answerSegments).toEqual([{ text: "Alpha beta gamma delta." }]);
  });

  it("attaches citations for multilingual clean prose with strong term overlap", () => {
    const result = attachImplicitCitationArtifacts(
      [
        {
          text: "Ananda offre corsi residenziali in Italiano.",
        },
      ],
      [
        {
          documentId: "doc-3",
          chunkId: "chunk-3",
          title: "Corsi residenziali",
          content: "Ananda offre corsi residenziali in Italiano per i visitatori interessati.",
        },
      ],
    );

    expect(result.citations).toEqual([
      { documentId: "doc-3", chunkId: "chunk-3", title: "Corsi residenziali" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Ananda offre corsi residenziali in Italiano.",
        citationIndices: [0],
      },
    ]);
  });
});
