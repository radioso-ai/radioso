import { describe, expect, it } from "vitest";

import { GroundedAnswerHeadReader } from "../../src/modules/chat/services/groundedAnswerHeadReader.js";

const HEAD = {
  coverage: "partial_insufficient_evidence",
  requestFocus: "the accommodation fee",
  outcome: "answer",
} as const;

const TAIL = {
  answer: "The workshop runs in June[[1]].",
  v: 2,
  claims: [[1]],
  suggestions: [],
  grounding: "degraded",
};

const fullEnvelope = (head: Record<string, unknown> = HEAD): string =>
  JSON.stringify({ ...head, ...TAIL });

/** Feeds one chunk at a time and returns the status after every push. */
const pushAll = (reader: GroundedAnswerHeadReader, raw: string, chunkSize: number) => {
  const statuses = [];
  for (let offset = 0; offset < raw.length; offset += chunkSize) {
    statuses.push(reader.push(raw.slice(offset, offset + chunkSize)));
  }
  return statuses;
};

describe("GroundedAnswerHeadReader", () => {
  it("resolves parsed once coverage, requestFocus, and outcome are all complete, at every chunk size", () => {
    const raw = fullEnvelope();
    for (let chunkSize = 1; chunkSize <= raw.length; chunkSize += 1) {
      const reader = new GroundedAnswerHeadReader();
      const statuses = pushAll(reader, raw, chunkSize);
      const resolved = statuses.find((status) => status.kind !== "pending");
      expect(resolved, `chunk size ${chunkSize}`).toEqual({ kind: "parsed", head: HEAD });
      expect(reader.current).toEqual(resolved);
    }
  });

  it("resolves the same head across chunk boundaries landing inside a key name", () => {
    const raw = fullEnvelope();
    const keyIndex = raw.indexOf('"requestFocus"');
    for (let split = keyIndex + 1; split < keyIndex + '"requestFocus"'.length; split += 1) {
      const reader = new GroundedAnswerHeadReader();
      reader.push(raw.slice(0, split));
      reader.push(raw.slice(split));
      expect(reader.current, `split at ${split}`).toEqual({ kind: "parsed", head: HEAD });
    }
  });

  it("resolves the same head across chunk boundaries landing inside an enum value", () => {
    const raw = fullEnvelope();
    const valueIndex = raw.indexOf(HEAD.coverage);
    for (let split = valueIndex + 1; split < valueIndex + HEAD.coverage.length; split += 1) {
      const reader = new GroundedAnswerHeadReader();
      reader.push(raw.slice(0, split));
      reader.push(raw.slice(split));
      expect(reader.current, `split at ${split}`).toEqual({ kind: "parsed", head: HEAD });
    }
  });

  it("resolves the same head across chunk boundaries landing inside an escaped string", () => {
    const escapedHead = { ...HEAD, requestFocus: 'the "day pass" option' };
    const raw = fullEnvelope(escapedHead);
    const escapeIndex = raw.indexOf('\\"');
    for (let split = escapeIndex; split <= escapeIndex + 1; split += 1) {
      const reader = new GroundedAnswerHeadReader();
      reader.push(raw.slice(0, split));
      reader.push(raw.slice(split));
      expect(reader.current, `split at ${split}`).toEqual({
        kind: "parsed",
        head: escapedHead,
      });
    }
  });

  it("resolves a surrogate-pair split inside requestFocus", () => {
    const raw = '{"coverage":"partial_insufficient_evidence",'
      + '"requestFocus":"the \\uD83D\\uDE00 emoji policy","outcome":"answer",'
      + '"answer":"Smile[[1]].","v":2,"claims":[[1]],"suggestions":[],"grounding":"degraded"}';
    const surrogateIndex = raw.indexOf("\\uD83D\\uDE00");
    for (const split of [surrogateIndex + 3, surrogateIndex + 6, surrogateIndex + 9]) {
      const reader = new GroundedAnswerHeadReader();
      reader.push(raw.slice(0, split));
      reader.push(raw.slice(split));
      expect(reader.current, `split at ${split}`).toEqual({
        kind: "parsed",
        head: { coverage: HEAD.coverage, requestFocus: "the 😀 emoji policy", outcome: "answer" },
      });
    }
  });

  it("is invalid the moment answer opens without a complete head", () => {
    const raw = '{"answer":"Too soon.","v":2,"outcome":"answer","claims":[],"suggestions":[]}';
    const reader = new GroundedAnswerHeadReader();
    for (let offset = 0; offset < raw.length; offset += 3) {
      reader.push(raw.slice(offset, offset + 3));
      if (reader.current.kind !== "pending") break;
    }
    expect(reader.current).toEqual({ kind: "invalid" });
  });

  it("is invalid once a fully out-of-order envelope completes without ever supplying coverage/requestFocus first", () => {
    const raw = JSON.stringify({ ...TAIL, ...HEAD });
    const reader = new GroundedAnswerHeadReader();
    for (const chunk of raw) {
      reader.push(chunk);
    }
    expect(reader.current).toEqual({ kind: "invalid" });
  });

  it("is invalid immediately for legacy free-text output that never opens a JSON object", () => {
    const reader = new GroundedAnswerHeadReader();
    expect(reader.push("The workshop runs")).toEqual({ kind: "invalid" });
    expect(reader.push(" in June.")).toEqual({ kind: "invalid" });
  });

  it("is invalid when the completed head carries an unrecognized coverage or outcome value", () => {
    const badCoverage = new GroundedAnswerHeadReader();
    badCoverage.push(fullEnvelope({ ...HEAD, coverage: "not_a_real_value" }));
    expect(badCoverage.current).toEqual({ kind: "invalid" });

    const badOutcome = new GroundedAnswerHeadReader();
    badOutcome.push(fullEnvelope({ ...HEAD, outcome: "maybe" }));
    expect(badOutcome.current).toEqual({ kind: "invalid" });
  });

  it("is invalid when requestFocus is blank", () => {
    const reader = new GroundedAnswerHeadReader();
    reader.push(fullEnvelope({ ...HEAD, requestFocus: "   " }));
    expect(reader.current).toEqual({ kind: "invalid" });
  });

  it("stays pending while only some head fields have streamed in", () => {
    const raw = fullEnvelope();
    const reader = new GroundedAnswerHeadReader();
    reader.push(raw.slice(0, raw.indexOf('"outcome"')));
    expect(reader.current).toEqual({ kind: "pending" });
  });

  it("bounds requestFocus to the shared max length even when the model overruns it", () => {
    const overlongFocus = "x".repeat(700);
    const reader = new GroundedAnswerHeadReader();
    reader.push(fullEnvelope({ ...HEAD, requestFocus: overlongFocus }));
    expect(reader.current).toEqual({
      kind: "parsed",
      head: { ...HEAD, requestFocus: "x".repeat(600) },
    });
  });

  it("ignores further pushes once resolved", () => {
    const raw = fullEnvelope();
    const reader = new GroundedAnswerHeadReader();
    reader.push(raw);
    const resolved = reader.current;
    reader.push('{"unexpected":"more data"}');
    expect(reader.current).toEqual(resolved);
  });
});
