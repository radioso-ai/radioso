import { describe, expect, it } from "vitest";

import {
  GroundedAnswerEnvelopeReader,
  parseGroundedAnswerEnvelope,
  SUGGESTIONS_SENTINEL,
} from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import {
  GROUNDED_V2_BODY,
  groundedV2Envelope,
} from "../support/answerEnvelopeV2Fixtures.js";

describe("parseGroundedAnswerEnvelope", () => {
  it("parses the v2 protocol without trusting the compatibility grounding field", () => {
    expect(parseGroundedAnswerEnvelope(groundedV2Envelope())).toEqual({
      answer: GROUNDED_V2_BODY,
      protocolVersion: 2,
      parseStatus: "valid_v2",
      outcome: "answer",
      claims: [[1], [2, 3]],
      suggestions: [
        { text: "What does registration require?", kind: "deeper", contextIndex: 2 },
      ],
    });
  });

  it("retains valid suggestions from legacy object and array envelopes but marks them v1", () => {
    const suggestion = { text: "Follow up?", kind: "deeper", contextIndex: 1 };
    for (const tail of [[suggestion], { grounding: "grounded", suggestions: [suggestion] }]) {
      const parsed = parseGroundedAnswerEnvelope(
        `Answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify(tail)}`,
      );
      expect(parsed).toMatchObject({ protocolVersion: 1, parseStatus: "legacy_v1", suggestions: [suggestion] });
    }
  });

  it("distinguishes missing, malformed, and invalid v2 tails", () => {
    expect(parseGroundedAnswerEnvelope("Answer.").parseStatus).toBe("missing");
    expect(parseGroundedAnswerEnvelope(`Answer.\n${SUGGESTIONS_SENTINEL}\n{bad`).parseStatus).toBe("malformed");
    expect(parseGroundedAnswerEnvelope(
      `Answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ v: 2, outcome: "answer", claims: "bad", suggestions: [] })}`,
    ).parseStatus).toBe("invalid_v2");
  });

  it("marks malformed v2 suggestions invalid while tolerating whitespace, key order, and extra keys", () => {
    const parsed = parseGroundedAnswerEnvelope(
      `Answer[[1]].\n${SUGGESTIONS_SENTINEL}\n ${JSON.stringify({
        extra: true,
        suggestions: [
          { text: " Valid? ", contextIndex: "1" },
          { text: "Bad?", kind: "invalid", contextIndex: 1 },
        ],
        claims: [[1]],
        outcome: "answer",
        v: "2",
      })} `,
    );
    expect(parsed).toMatchObject({
      parseStatus: "invalid_v2",
      suggestions: [{ text: "Valid?", kind: "deeper", contextIndex: 1 }],
    });
  });
});

describe("GroundedAnswerEnvelopeReader", () => {
  it("never leaks a sentinel split at any boundary", () => {
    const tail = JSON.stringify({ v: 2, outcome: "answer", claims: [[1]], suggestions: [] });
    for (let split = 1; split < SUGGESTIONS_SENTINEL.length; split += 1) {
      const reader = new GroundedAnswerEnvelopeReader();
      const chunks = [
        reader.push(`Answer[[1]].\n${SUGGESTIONS_SENTINEL.slice(0, split)}`),
        reader.push(`${SUGGESTIONS_SENTINEL.slice(split)}\n${tail}`),
      ];
      const finalized = reader.finalize();
      expect(chunks.join("")).toBe("Answer[[1]].");
      expect(chunks.join("")).not.toContain("RADIOSO");
      expect(finalized).toMatchObject({
        fullAnswer: "Answer[[1]].",
        parseStatus: "valid_v2",
        outcome: "answer",
        claims: [[1]],
      });
    }
  });

  it("never leaks the CRLF delimiter when the sentinel is split at any boundary", () => {
    const tail = JSON.stringify({ v: 2, outcome: "answer", claims: [[1]], suggestions: [] });
    for (let split = 1; split < SUGGESTIONS_SENTINEL.length; split += 1) {
      const reader = new GroundedAnswerEnvelopeReader();
      const chunks = [
        reader.push(`Answer[[1]].\r\n${SUGGESTIONS_SENTINEL.slice(0, split)}`),
        reader.push(`${SUGGESTIONS_SENTINEL.slice(split)}\r\n${tail}`),
      ];
      const finalized = reader.finalize();
      expect(chunks.join(""), `split at ${split}`).toBe("Answer[[1]].");
      expect(finalized.fullAnswer).toBe("Answer[[1]].");
    }
  });

  it("buffers all tail bytes and never emits them", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    const yielded = [
      reader.push("Answer[[1]]."),
      reader.push(`\n${SUGGESTIONS_SENTINEL}\n`),
      reader.push('{"v":2,"outcome":"answer",'),
      reader.push('"claims":[[1]],"suggestions":[]}'),
    ];
    const finalized = reader.finalize();
    expect(yielded.join("")).toBe("Answer[[1]].");
    expect(finalized.suggestions).toEqual([]);
    expect(finalized.parseStatus).toBe("valid_v2");
  });

  it("returns held answer bytes with missing status when no sentinel arrives", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    const emitted = reader.push("Answer with no sentinel anywhere.");
    const finalized = reader.finalize();
    expect(emitted + finalized.trailingAnswer).toBe("Answer with no sentinel anywhere.");
    expect(finalized).toMatchObject({ fullAnswer: "Answer with no sentinel anywhere.", parseStatus: "missing" });
  });
});
