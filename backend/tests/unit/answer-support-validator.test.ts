import { describe, expect, it } from "vitest";

import { AnswerSupportValidator } from "../../src/modules/chat/services/answerSupportValidator.js";
import {
  ASSISTANT_TURN_OUTCOME,
  AssistantTurnOutcomeClassifier,
  DEFAULT_UNSUPPORTED_NOTICE,
} from "../../src/modules/chat/services/assistantTurnOutcomeClassifier.js";
import type { CitationEvidence } from "../../src/modules/chat/services/answerPresentationService.js";

const citations: CitationEvidence[] = [
  {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Guide",
    content: "The page explains testing and parsing content for users.",
  },
];

describe("answer support validator", () => {
  it("keeps supported segments, replaces unsupported substantive segments, and preserves non-substantive wrappers", () => {
    const validator = new AnswerSupportValidator();

    const result = validator.validate({
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
      citationDisplayEnabled: true,
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
    });
    expect(result.segmentResults.map((segment) => segment.disposition)).toEqual([
      "supported",
      "non_substantive",
      "unsupported",
      "non_substantive",
      "non_substantive",
    ]);
  });

  it("collapses fully unsupported substantive answers to only the unsupported notice", () => {
    const validator = new AnswerSupportValidator();

    const result = validator.validate({
      answer: "It also offers 24/7 phone support and a discount code.",
      answerSegments: [
        { text: "It also offers 24/7 phone support and a discount code" },
        { text: "." },
      ],
      citationEvidence: [],
      citationDisplayEnabled: true,
    });

    expect(result.answer).toBe(DEFAULT_UNSUPPORTED_NOTICE);
    expect(result.citations).toEqual([]);
    expect(result.answerSegments).toEqual([{ text: DEFAULT_UNSUPPORTED_NOTICE }]);
    expect(result.validation).toEqual({
      ran: true,
      answerModified: true,
      unsupportedSegmentCount: 1,
      supportedSegmentCount: 0,
      nonSubstantiveSegmentCount: 1,
    });
  });

  it("omits visible citation artifacts when citation display is disabled but still classifies support correctly", () => {
    const validator = new AnswerSupportValidator();

    const result = validator.validate({
      answer: "The page explains testing and parsing content for users.",
      answerSegments: [
        {
          text: "The page explains testing and parsing content for users",
          citationIndices: [0],
        },
        { text: "." },
      ],
      citationEvidence: citations,
      citationDisplayEnabled: false,
    });

    expect(result.answer).toBe("The page explains testing and parsing content for users.");
    expect(result.citations).toBeUndefined();
    expect(result.answerSegments).toBeUndefined();
    expect(result.validation.answerModified).toBe(false);
    expect(result.validation.supportedSegmentCount).toBe(1);
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
