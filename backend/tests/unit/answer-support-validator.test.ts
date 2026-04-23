import { describe, expect, it } from "vitest";

import { AnswerSupportValidator } from "../../src/modules/chat/services/answerSupportValidator.js";
import {
  ASSISTANT_TURN_OUTCOME,
  AssistantTurnOutcomeClassifier,
} from "../../src/modules/chat/services/assistantTurnOutcomeClassifier.js";
import type { CitationEvidence } from "../../src/modules/chat/services/answerPresentationService.js";
import type { GroundedMissResponseComposer } from "../../src/modules/chat/services/groundedMissResponseComposer.js";

const citations: CitationEvidence[] = [
  {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Guide",
    content: "The page explains testing and parsing content for users.",
    sourceUrl: "https://example.com/guide",
  },
];

const groundedMissResponseComposer: GroundedMissResponseComposer = {
  async composeUnsupportedWithContext() {
    return "No se pudo verificar esa respuesta con los documentos recuperados.";
  },
  async composeNoContext() {
    return "No se encontró material relevante en el espacio de trabajo.";
  },
};

describe("answer support validator", () => {
  it("keeps supported segments and omits unsupported substantive tails", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "What does the page explain?",
      answer: "The page explains testing and parsing content for users. It also offers 24/7 phone support. Thanks!",
      answerSegments: [
        {
          text: "The page explains testing and parsing content for users",
          citationIndices: [0],
        },
        { text: ". " },
        { text: "It also offers 24/7 phone support" },
        { text: ". " },
        { text: "Thanks!" },
      ],
      citationEvidence: citations,
      retrievedContextSummaries: citations.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("The page explains testing and parsing content for users.");
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Guide" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "The page explains testing and parsing content for users",
        citationIndices: [0],
      },
      { text: "." },
    ]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: true,
      unsupportedSegmentCount: 2,
      substantiveUnsupportedSegmentCount: 2,
      supportedSegmentCount: 1,
      nonSubstantiveSegmentCount: 2,
      answerSupportPolicy: "strict",
    });
    expect(result.segmentResults.map((segment) => segment.disposition)).toEqual([
      "supported",
      "non_substantive",
      "unsupported",
      "non_substantive",
      "unsupported",
    ]);
  });

  it("collapses fully unsupported substantive answers to the grounded-miss response", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "What support is offered?",
      answer: "It also offers 24/7 phone support and a discount code.",
      answerSegments: [
        { text: "It also offers 24/7 phone support and a discount code" },
        { text: "." },
      ],
      citationEvidence: [],
      retrievedContextSummaries: [],
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("No se pudo verificar esa respuesta con los documentos recuperados.");
    expect(result.citations).toEqual([]);
    expect(result.answerSegments).toEqual([{ text: "No se pudo verificar esa respuesta con los documentos recuperados." }]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: true,
      unsupportedSegmentCount: 1,
      substantiveUnsupportedSegmentCount: 1,
      supportedSegmentCount: 0,
      nonSubstantiveSegmentCount: 1,
      answerSupportPolicy: "strict",
    });
  });

  it("omits visible citation artifacts when citation display is disabled but still classifies support correctly", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "What does the page explain?",
      answer: "The page explains testing and parsing content for users.",
      answerSegments: [
        {
          text: "The page explains testing and parsing content for users",
          citationIndices: [0],
        },
        { text: "." },
      ],
      citationEvidence: citations,
      retrievedContextSummaries: citations.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled: false,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("The page explains testing and parsing content for users.");
    expect(result.citations).toBeUndefined();
    expect(result.answerSegments).toBeUndefined();
    expect(result.validation.answerModified).toBe(false);
    expect(result.validation.supportedSegmentCount).toBe(1);
  });

  it("treats punctuation-only wrappers as non-substantive", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "Can you help?",
      answer: "... !?",
      answerSegments: [
        { text: "..." },
        { text: " " },
        { text: "!?" },
      ],
      citationEvidence: [],
      retrievedContextSummaries: [],
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("... !?");
    expect(result.answerSegments).toEqual([
      { text: "..." },
      { text: " " },
      { text: "!?" },
    ]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: false,
      unsupportedSegmentCount: 0,
      substantiveUnsupportedSegmentCount: 0,
      supportedSegmentCount: 0,
      nonSubstantiveSegmentCount: 3,
      answerSupportPolicy: "strict",
    });
  });

  it("omits consecutive unsupported claims within mixed answers", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "What does the page explain?",
      answer: "The page explains testing and parsing content for users. It offers 24/7 phone support. It also offers a discount code.",
      answerSegments: [
        {
          text: "The page explains testing and parsing content for users",
          citationIndices: [0],
        },
        { text: ". " },
        { text: "It offers 24/7 phone support" },
        { text: ". " },
        { text: "It also offers a discount code" },
        { text: "." },
      ],
      citationEvidence: citations,
      retrievedContextSummaries: citations.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("The page explains testing and parsing content for users.");
    expect(result.answerSegments).toEqual([
      { text: "The page explains testing and parsing content for users", citationIndices: [0] },
      { text: "." },
    ]);
    expect(result.validation.unsupportedSegmentCount).toBe(2);
  });

  it("counts unsupported non-Latin text as substantive", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "Что сказано на странице?",
      answer: "Страница объясняет тестирование. Она также обещает круглосуточную поддержку.",
      answerSegments: [
        {
          text: "Страница объясняет тестирование",
          citationIndices: [0],
        },
        { text: ". " },
        { text: "Она также обещает круглосуточную поддержку" },
        { text: "." },
      ],
      citationEvidence: citations,
      retrievedContextSummaries: citations.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("Страница объясняет тестирование.");
    expect(result.validation.unsupportedSegmentCount).toBe(1);
    expect(result.validation.substantiveUnsupportedSegmentCount).toBe(1);
  });

  it("preserves unsupported content under warn without replacing it", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "Who is Narayani?",
      answer: "Narayani is a teacher and author.",
      answerSegments: [{ text: "Narayani is a teacher and author" }, { text: "." }],
      citationEvidence: [],
      retrievedContextSummaries: [],
      citationDisplayEnabled: true,
      answerSupportPolicy: "warn",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("Narayani is a teacher and author.");
    expect(result.validation.answerModified).toBe(false);
    expect(result.validation.answerSupportPolicy).toBe("warn");
    expect(result.segmentResults[0]).toMatchObject({
      text: "Narayani is a teacher and author",
      replacementApplied: false,
      disposition: "unsupported",
    });
  });

  it("recovers clearly grounded segments even when citation anchors are missing", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "How should I start meditating?",
      answer: "Keep it short and simple. Begin with a few minutes each day.",
      answerSegments: [
        {
          text: "Keep it short and simple. Begin with a few minutes each day.",
        },
      ],
      citationEvidence: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Meditation Tips",
          content: "Keep it short and simple. Begin with a few minutes each day instead of starting with a long session.",
          sourceUrl: "https://example.com/meditation",
        },
      ],
      retrievedContextSummaries: [
        {
          title: "Meditation Tips",
          content: "Keep it short and simple. Begin with a few minutes each day instead of starting with a long session.",
        },
      ],
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("Keep it short and simple. Begin with a few minutes each day.");
    expect(result.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" }]);
    expect(result.answerSegments).toEqual([
      {
        text: "Keep it short and simple. Begin with a few minutes each day.",
        citationIndices: [0],
      },
    ]);
    expect(result.validation.answerModified).toBe(false);
    expect(result.validation.supportedSegmentCount).toBe(1);
  });

  it("treats bare link-only follow-up segments as supported when the URL matches cited source metadata", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "Where can I read more?",
      answer: "The page explains testing and parsing content for users.\n\n[Guide](https://example.com/guide)",
      answerSegments: [
        {
          text: "The page explains testing and parsing content for users",
          citationIndices: [0],
        },
        {
          text: "\n\n[Guide](https://example.com/guide)",
        },
      ],
      citationEvidence: citations,
      retrievedContextSummaries: citations.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe(
      "The page explains testing and parsing content for users.\n\n[Guide](https://example.com/guide)",
    );
    expect(result.answerSegments).toEqual([
      {
        text: "The page explains testing and parsing content for users",
        citationIndices: [0],
      },
      {
        text: "\n\n[Guide](https://example.com/guide)",
        citationIndices: [0],
      },
    ]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: false,
      unsupportedSegmentCount: 0,
      substantiveUnsupportedSegmentCount: 0,
      supportedSegmentCount: 2,
      nonSubstantiveSegmentCount: 0,
      answerSupportPolicy: "strict",
    });
  });

  it("does not treat unsupported prose plus a cited URL as fully supported", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "What support is offered?",
      answer: "The guide also offers 24/7 support: [Guide](https://example.com/guide)",
      answerSegments: [
        {
          text: "The guide also offers 24/7 support: [Guide](https://example.com/guide)",
        },
      ],
      citationEvidence: citations,
      retrievedContextSummaries: citations.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      conversationMode: "guided",
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("No se pudo verificar esa respuesta con los documentos recuperados.");
    expect(result.validation.unsupportedSegmentCount).toBe(1);
    expect(result.validation.supportedSegmentCount).toBe(0);
  });
});

describe("assistant turn outcome classifier", () => {
  it("returns grounded success for unchanged validated grounded answers", () => {
    const classifier = new AssistantTurnOutcomeClassifier();

    expect(
      classifier.classify({
        hadRetrievedContext: true,
        validation: {
          ran: true,
          answerModified: false,
          unsupportedSegmentCount: 0,
          substantiveUnsupportedSegmentCount: 0,
          supportedSegmentCount: 2,
          nonSubstantiveSegmentCount: 1,
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS);
  });

  it("returns degraded outcome when unsupported segments were replaced", () => {
    const classifier = new AssistantTurnOutcomeClassifier();

    expect(
      classifier.classify({
        hadRetrievedContext: true,
        validation: {
          ran: true,
          answerModified: true,
          unsupportedSegmentCount: 1,
          substantiveUnsupportedSegmentCount: 1,
          supportedSegmentCount: 1,
          nonSubstantiveSegmentCount: 0,
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.GROUNDED_DEGRADED_UNSUPPORTED_SEGMENTS);
  });

  it("returns degraded outcome when unsupported segments are preserved under warn/off", () => {
    const classifier = new AssistantTurnOutcomeClassifier();

    expect(
      classifier.classify({
        hadRetrievedContext: true,
        validation: {
          ran: true,
          answerModified: false,
          unsupportedSegmentCount: 1,
          substantiveUnsupportedSegmentCount: 1,
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
          answerSupportPolicy: "warn",
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.GROUNDED_DEGRADED_UNSUPPORTED_SEGMENTS);
  });

  it("keeps no-context refusals distinct from validator-triggered degradation", () => {
    const classifier = new AssistantTurnOutcomeClassifier();

    expect(
      classifier.classify({
        hadRetrievedContext: false,
        validation: {
          ran: false,
          answerModified: false,
          unsupportedSegmentCount: 0,
          substantiveUnsupportedSegmentCount: 0,
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL);
  });

  it("treats whitespace-only unsupported tails as non-substantive for outcome classification", () => {
    const classifier = new AssistantTurnOutcomeClassifier();

    expect(
      classifier.classify({
        hadRetrievedContext: true,
        validation: {
          ran: true,
          answerModified: true,
          unsupportedSegmentCount: 1,
          substantiveUnsupportedSegmentCount: 0,
          supportedSegmentCount: 1,
          nonSubstantiveSegmentCount: 1,
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS);
  });

  it("keeps non-Latin unsupported content on the degraded path", () => {
    const classifier = new AssistantTurnOutcomeClassifier();

    expect(
      classifier.classify({
        hadRetrievedContext: true,
        validation: {
          ran: true,
          answerModified: true,
          unsupportedSegmentCount: 1,
          substantiveUnsupportedSegmentCount: 1,
          supportedSegmentCount: 1,
          nonSubstantiveSegmentCount: 1,
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.GROUNDED_DEGRADED_UNSUPPORTED_SEGMENTS);
  });
});
