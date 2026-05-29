import { describe, expect, it } from "vitest";

import {
  GroundedAnswerEnvelopeReader,
  parseGroundedAnswerEnvelope,
  SUGGESTIONS_SENTINEL,
} from "../../src/modules/chat/services/groundedAnswerEnvelope.js";

const formatEnvelope = (answer: string, suggestions: unknown[]): string =>
  `${answer}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify(suggestions)}`;

describe("parseGroundedAnswerEnvelope", () => {
  it("splits answer markdown from the suggestions JSON array", () => {
    const raw = formatEnvelope("Yoga supports breathing and posture.", [
      { text: "What beginner classes are available?", kind: "deeper", contextIndex: 1 },
      { text: "How does yoga compare to pilates?", kind: "broader", contextIndex: 2 },
    ]);

    const result = parseGroundedAnswerEnvelope(raw);
    expect(result.answer).toBe("Yoga supports breathing and posture.");
    expect(result.suggestions).toEqual([
      { text: "What beginner classes are available?", kind: "deeper", contextIndex: 1 },
      { text: "How does yoga compare to pilates?", kind: "broader", contextIndex: 2 },
    ]);
  });

  it("treats output without the sentinel as a plain answer", () => {
    const result = parseGroundedAnswerEnvelope("Plain text answer with no sentinel.");
    expect(result.answer).toBe("Plain text answer with no sentinel.");
    expect(result.suggestions).toEqual([]);
  });

  it("returns an empty suggestions array when the JSON is malformed", () => {
    const raw = `Some answer.\n${SUGGESTIONS_SENTINEL}\n{not valid json`;
    const result = parseGroundedAnswerEnvelope(raw);
    expect(result.answer).toBe("Some answer.");
    expect(result.suggestions).toEqual([]);
  });

  it("accepts an object-wrapped suggestions field as a fallback", () => {
    const raw = `Some answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({
      suggestions: [{ text: "Follow up?", kind: "deeper", contextIndex: 1 }],
    })}`;
    const result = parseGroundedAnswerEnvelope(raw);
    expect(result.suggestions).toEqual([
      { text: "Follow up?", kind: "deeper", contextIndex: 1 },
    ]);
  });

  it("defaults the grounding verdict to grounded for a bare suggestions array", () => {
    const raw = formatEnvelope("A fully grounded answer.", [
      { text: "Follow up?", kind: "deeper", contextIndex: 1 },
    ]);
    expect(parseGroundedAnswerEnvelope(raw).grounding).toBe("grounded");
  });

  it("reads a model-emitted degraded grounding verdict from the object envelope", () => {
    const raw = `Partial answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({
      grounding: "degraded",
      suggestions: [{ text: "Follow up?", kind: "deeper", contextIndex: 1 }],
    })}`;
    const result = parseGroundedAnswerEnvelope(raw);
    expect(result.grounding).toBe("degraded");
    expect(result.suggestions).toEqual([
      { text: "Follow up?", kind: "deeper", contextIndex: 1 },
    ]);
  });

  it("falls back to grounded for an unrecognized grounding value", () => {
    const raw = `Answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({
      grounding: "totally-made-up",
      suggestions: [],
    })}`;
    expect(parseGroundedAnswerEnvelope(raw).grounding).toBe("grounded");
  });

  it("drops invalid entries while keeping valid ones", () => {
    const raw = formatEnvelope("Some answer.", [
      { text: "Valid?", kind: "deeper", contextIndex: 1 },
      { text: "", kind: "deeper", contextIndex: 2 },
      { text: "Bad index?", kind: "deeper", contextIndex: 0 },
      { text: "Bad kind?", kind: "narrower", contextIndex: 1 },
      { text: "Defaults kind to deeper?", contextIndex: 3 },
    ]);

    const result = parseGroundedAnswerEnvelope(raw);
    expect(result.suggestions).toEqual([
      { text: "Valid?", kind: "deeper", contextIndex: 1 },
      { text: "Defaults kind to deeper?", kind: "deeper", contextIndex: 3 },
    ]);
  });
});

describe("GroundedAnswerEnvelopeReader", () => {
  it("emits answer text incrementally and parses suggestions after the sentinel", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    const yielded: string[] = [];

    yielded.push(reader.push("The first part of the answer "));
    yielded.push(reader.push("continues here, with citations[[1]]."));
    yielded.push(reader.push(`\n${SUGGESTIONS_SENTINEL}\n[{"text":"Ask a follow-up?","kind":"deeper","contextIndex":1}]`));

    const finalized = reader.finalize();

    expect(yielded.join("")).toBe("The first part of the answer continues here, with citations[[1]].\n");
    expect(finalized.fullAnswer).toBe("The first part of the answer continues here, with citations[[1]].\n");
    expect(finalized.suggestions).toEqual([
      { text: "Ask a follow-up?", kind: "deeper", contextIndex: 1 },
    ]);
  });

  it("exposes the grounding verdict from the finalized envelope", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    reader.push("Hedged answer with a single citation[[1]].");
    reader.push(`\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ grounding: "degraded", suggestions: [] })}`);

    const finalized = reader.finalize();
    expect(finalized.grounding).toBe("degraded");
  });

  it("defaults the finalized grounding verdict to grounded", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    reader.push("Plain answer with no sentinel.");
    expect(reader.finalize().grounding).toBe("grounded");
  });

  it("handles the sentinel split across multiple chunks", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    const sentinelHalfA = SUGGESTIONS_SENTINEL.slice(0, 10);
    const sentinelHalfB = SUGGESTIONS_SENTINEL.slice(10);
    const yielded: string[] = [];

    yielded.push(reader.push("Body text "));
    yielded.push(reader.push(`finishes.\n${sentinelHalfA}`));
    yielded.push(reader.push(`${sentinelHalfB}\n[]`));

    const finalized = reader.finalize();
    expect(yielded.join("")).toBe("Body text finishes.\n");
    expect(finalized.suggestions).toEqual([]);
  });

  it("returns the full buffer as answer when no sentinel ever appears", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    const emitted = reader.push("Answer with no sentinel anywhere.");
    const finalized = reader.finalize();

    expect(emitted + finalized.trailingAnswer).toBe("Answer with no sentinel anywhere.");
    expect(finalized.fullAnswer).toBe("Answer with no sentinel anywhere.");
    expect(finalized.suggestions).toEqual([]);
  });

  it("ignores empty chunks", () => {
    const reader = new GroundedAnswerEnvelopeReader();
    expect(reader.push("")).toBe("");
    expect(reader.push("hi ")).toBe("");
    const finalized = reader.finalize();
    expect(finalized.fullAnswer).toBe("hi ");
  });
});
