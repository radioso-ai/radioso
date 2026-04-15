import { describe, expect, it } from "vitest";

import { AnswerSupportValidator } from "../../src/modules/chat/services/answerSupportValidator.js";
import {
  ASSISTANT_TURN_OUTCOME,
  AssistantTurnOutcomeClassifier,
  DEFAULT_UNSUPPORTED_NOTICE,
} from "../../src/modules/chat/services/assistantTurnOutcomeClassifier.js";
import type { CitationEvidence } from "../../src/modules/chat/services/answerPresentationService.js";
import {
  DefaultGroundedMissResponseComposer,
  DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";
import type { UnsupportedNoticeGenerator } from "../../src/modules/chat/services/unsupportedNoticeGenerator.js";

const citations: CitationEvidence[] = [
  {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Guide",
    content: "The page explains testing and parsing content for users.",
  },
];

const staticNoticeGenerator = (text = DEFAULT_UNSUPPORTED_NOTICE): UnsupportedNoticeGenerator => ({
  async generate() {
    return text;
  },
});

const groundedMissResponseComposer = new DefaultGroundedMissResponseComposer();

describe("answer support validator", () => {
  it("keeps supported segments, replaces unsupported substantive segments, and preserves non-substantive wrappers", async () => {
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
      unsupportedNoticeGenerator: staticNoticeGenerator(),
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe(
      `The page explains testing and parsing content for users. ${DEFAULT_UNSUPPORTED_NOTICE} Thanks!`,
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Guide" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "The page explains testing and parsing content for users",
        citationIndices: [0],
      },
      { text: ". " },
      { text: DEFAULT_UNSUPPORTED_NOTICE },
      { text: " " },
      { text: "Thanks!" },
    ]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: true,
      unsupportedSegmentCount: 1,
      supportedSegmentCount: 1,
      nonSubstantiveSegmentCount: 3,
      answerSupportPolicy: "strict",
    });
    expect(result.segmentResults.map((segment) => segment.disposition)).toEqual([
      "supported",
      "non_substantive",
      "unsupported",
      "non_substantive",
      "non_substantive",
    ]);
  });

  it("collapses fully unsupported substantive answers to only the unsupported notice", async () => {
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
      unsupportedNoticeGenerator: staticNoticeGenerator(),
      groundedMissResponseComposer: new DefaultGroundedMissResponseComposer(),
    });

    expect(result.answer).toBe(DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE);
    expect(result.citations).toEqual([]);
    expect(result.answerSegments).toEqual([{ text: DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE }]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: true,
      unsupportedSegmentCount: 1,
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
      unsupportedNoticeGenerator: staticNoticeGenerator(),
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("The page explains testing and parsing content for users.");
    expect(result.citations).toBeUndefined();
    expect(result.answerSegments).toBeUndefined();
    expect(result.validation.answerModified).toBe(false);
    expect(result.validation.supportedSegmentCount).toBe(1);
  });

  it("treats common conversational wrappers as non-substantive", async () => {
    const validator = new AnswerSupportValidator();

    const result = await validator.validate({
      query: "Can you help?",
      answer: "Sure. Of course! Glad to help.",
      answerSegments: [
        { text: "Sure" },
        { text: ". " },
        { text: "Of course" },
        { text: "! " },
        { text: "Glad to help" },
        { text: "." },
      ],
      citationEvidence: [],
      retrievedContextSummaries: [],
      citationDisplayEnabled: true,
      answerSupportPolicy: "strict",
      unsupportedNoticeGenerator: staticNoticeGenerator(),
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe("Sure. Of course! Glad to help.");
    expect(result.answerSegments).toEqual([
      { text: "Sure" },
      { text: ". " },
      { text: "Of course" },
      { text: "! " },
      { text: "Glad to help" },
      { text: "." },
    ]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: false,
      unsupportedSegmentCount: 0,
      supportedSegmentCount: 0,
      nonSubstantiveSegmentCount: 6,
      answerSupportPolicy: "strict",
    });
  });

  it("deduplicates consecutive unsupported notices within mixed answers", async () => {
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
      unsupportedNoticeGenerator: staticNoticeGenerator(),
      groundedMissResponseComposer,
    });

    expect(result.answer).toBe(
      `The page explains testing and parsing content for users. ${DEFAULT_UNSUPPORTED_NOTICE}`,
    );
    expect(result.answerSegments).toEqual([
      { text: "The page explains testing and parsing content for users", citationIndices: [0] },
      { text: ". " },
      { text: DEFAULT_UNSUPPORTED_NOTICE },
    ]);
    expect(result.validation.unsupportedSegmentCount).toBe(2);
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
      unsupportedNoticeGenerator: staticNoticeGenerator("No pude verificar esa parte."),
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
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
        },
      }),
    ).toBe(ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL);
  });
});
