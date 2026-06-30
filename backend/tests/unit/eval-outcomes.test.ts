import { describe, expect, it } from "vitest";

import { aggregateAssertions, evaluateAssertion } from "../../src/modules/eval/domain/outcomes.js";

describe("evaluateAssertion answer_cites_document", () => {
  it("passes when the answer cites the target document", () => {
    const verdict = evaluateAssertion(
      { type: "answer_cites_document", documentId: "doc-1" },
      {
        retrievedChunks: [],
        answer: "Grounded answer.",
        citations: [
          { documentId: "doc-other", chunkId: "c1", title: "X" },
          { documentId: "doc-1", chunkId: "c2", title: "Target" },
        ],
      },
    );

    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("doc-1");
    expect(verdict.reason).not.toContain("c2");
  });

  it("fails when the answer cites no such document", () => {
    const verdict = evaluateAssertion(
      { type: "answer_cites_document", documentId: "doc-missing" },
      {
        retrievedChunks: [],
        answer: "Grounded answer.",
        citations: [{ documentId: "doc-a", chunkId: "c1", title: "A" }],
      },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-missing");
  });

  it("fails when the answer carries no citations at all", () => {
    const verdict = evaluateAssertion(
      { type: "answer_cites_document", documentId: "doc-x" },
      { retrievedChunks: [], answer: "Ungrounded answer.", citations: [] },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-x");
  });

  it("errors when no answer was produced (wrong run mode)", () => {
    const verdict = evaluateAssertion(
      { type: "answer_cites_document", documentId: "doc-x" },
      { retrievedChunks: [] },
    );

    expect(verdict.status).toBe("error");
    expect(verdict.reason).toContain("full_assistant");
  });
});

describe("evaluateAssertion retrieval_includes_document", () => {
  it("passes when the target document appears in retrieved chunks", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_includes_document", documentId: "doc-1" },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-other", title: "X", rank: 0 },
          { chunkId: "c2", documentId: "doc-1", title: "Target", rank: 1 },
        ],
      },
    );

    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("doc-1");
    // The reason references the document, not the internal chunk id.
    expect(verdict.reason).not.toContain("c2");
  });

  it("fails when target document is missing from retrieved chunks", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_includes_document", documentId: "doc-missing" },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-a", title: "A", rank: 0 },
          { chunkId: "c2", documentId: "doc-b", title: "B", rank: 1 },
        ],
      },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-missing");
  });

  it("fails with a clear reason when retrieval returned nothing", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_includes_document", documentId: "doc-x" },
      { retrievedChunks: [] },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-x");
  });

  it("returns error status when observed output carries an error", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_includes_document", documentId: "doc-x" },
      {
        retrievedChunks: [],
        error: { message: "embedding provider down" },
      },
    );

    expect(verdict.status).toBe("error");
    expect(verdict.reason).toBe("embedding provider down");
  });
});

describe("evaluateAssertion retrieval_excludes_document", () => {
  it("passes when the named document does NOT appear in retrieved chunks", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_excludes_document", documentId: "doc-stale" },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-current", title: "Current", rank: 0 },
          { chunkId: "c2", documentId: "doc-other", title: "Other", rank: 1 },
        ],
      },
    );

    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("doc-stale");
  });

  it("fails when the named document still appears in retrieved chunks", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_excludes_document", documentId: "doc-stale" },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-current", title: "Current", rank: 0 },
          { chunkId: "c2", documentId: "doc-stale", title: "Stale", rank: 1 },
        ],
      },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-stale");
    // The reason references the document, not the internal chunk id.
    expect(verdict.reason).not.toContain("c2");
  });

  it("passes when nothing was retrieved", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_excludes_document", documentId: "doc-x" },
      { retrievedChunks: [] },
    );

    expect(verdict.status).toBe("pass");
  });
});

describe("evaluateAssertion retrieval_top_k_includes_document", () => {
  it("passes when the target document's first chunk is within the top K", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_top_k_includes_document", documentId: "doc-target", k: 3 },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-other", title: "O", rank: 0 },
          { chunkId: "c2", documentId: "doc-target", title: "T", rank: 1 },
          { chunkId: "c3", documentId: "doc-other", title: "O", rank: 2 },
        ],
      },
    );

    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("doc-target");
    expect(verdict.reason).toMatch(/top 3|position 1|rank 1/i);
  });

  it("fails when the target document only appears outside the top K", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_top_k_includes_document", documentId: "doc-target", k: 2 },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-other", title: "O", rank: 0 },
          { chunkId: "c2", documentId: "doc-other", title: "O", rank: 1 },
          { chunkId: "c3", documentId: "doc-target", title: "T", rank: 2 },
        ],
      },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-target");
    expect(verdict.reason).toMatch(/top 2/i);
  });

  it("fails when the target document is not retrieved at all", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_top_k_includes_document", documentId: "doc-target", k: 5 },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-other", title: "O", rank: 0 },
        ],
      },
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("doc-target");
  });

  it("uses array position for ranking even if the rank field is irregular", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_top_k_includes_document", documentId: "doc-target", k: 2 },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-other", title: "O", rank: 47 },
          { chunkId: "c2", documentId: "doc-target", title: "T", rank: 99 },
          { chunkId: "c3", documentId: "doc-other", title: "O", rank: 100 },
        ],
      },
    );

    expect(verdict.status).toBe("pass");
  });

  it("errors clearly when k is not a positive integer", () => {
    const verdict = evaluateAssertion(
      { type: "retrieval_top_k_includes_document", documentId: "doc-target", k: 0 },
      {
        retrievedChunks: [
          { chunkId: "c1", documentId: "doc-target", title: "T", rank: 0 },
        ],
      },
    );

    expect(verdict.status).toBe("error");
    expect(verdict.reason).toMatch(/k|positive/i);
  });
});

describe("evaluateAssertion answer_contains / answer_does_not_contain", () => {
  const chunkSet = [{ chunkId: "c1", documentId: "doc-a", title: "A", rank: 0 }];

  it("answer_contains passes when the substring is present (case-insensitive by default)", () => {
    const verdict = evaluateAssertion(
      { type: "answer_contains", pattern: "Refund", matchMode: "substring" },
      { retrievedChunks: chunkSet, answer: "our refund window is 30 days." },
    );
    expect(verdict.status).toBe("pass");
  });

  it("answer_contains fails when the substring is absent", () => {
    const verdict = evaluateAssertion(
      { type: "answer_contains", pattern: "refund", matchMode: "substring" },
      { retrievedChunks: chunkSet, answer: "I don't know." },
    );
    expect(verdict.status).toBe("fail");
  });

  it("answer_contains respects caseSensitive=true", () => {
    const pass = evaluateAssertion(
      { type: "answer_contains", pattern: "Refund", matchMode: "substring", caseSensitive: true },
      { retrievedChunks: chunkSet, answer: "Our Refund window is 30 days." },
    );
    const fail = evaluateAssertion(
      { type: "answer_contains", pattern: "Refund", matchMode: "substring", caseSensitive: true },
      { retrievedChunks: chunkSet, answer: "our refund window is 30 days." },
    );
    expect(pass.status).toBe("pass");
    expect(fail.status).toBe("fail");
  });

  it("answer_contains supports regex mode", () => {
    const verdict = evaluateAssertion(
      { type: "answer_contains", pattern: "\\d+\\s*days?", matchMode: "regex" },
      { retrievedChunks: chunkSet, answer: "refund window: 30 days from purchase" },
    );
    expect(verdict.status).toBe("pass");
  });

  it("answer_contains errors when the regex is invalid", () => {
    const verdict = evaluateAssertion(
      { type: "answer_contains", pattern: "[unterminated", matchMode: "regex" },
      { retrievedChunks: chunkSet, answer: "any" },
    );
    expect(verdict.status).toBe("error");
  });

  it("answer_does_not_contain passes when the substring is absent", () => {
    const verdict = evaluateAssertion(
      { type: "answer_does_not_contain", pattern: "free", matchMode: "substring" },
      { retrievedChunks: chunkSet, answer: "Our refund window is 30 days." },
    );
    expect(verdict.status).toBe("pass");
  });

  it("answer_does_not_contain fails when the substring leaks into the answer", () => {
    const verdict = evaluateAssertion(
      { type: "answer_does_not_contain", pattern: "free", matchMode: "substring" },
      { retrievedChunks: chunkSet, answer: "Shipping is free worldwide." },
    );
    expect(verdict.status).toBe("fail");
  });

  it("answer assertions error when the run mode produced no answer", () => {
    const verdict = evaluateAssertion(
      { type: "answer_contains", pattern: "refund", matchMode: "substring" },
      { retrievedChunks: chunkSet },
    );
    expect(verdict.status).toBe("error");
    expect(verdict.reason).toMatch(/full_assistant/);
  });
});

describe("aggregateAssertions", () => {
  const chunk = (chunkId: string, documentId: string) =>
    ({ chunkId, documentId, title: documentId, rank: 0 });

  it("returns 'recorded' with no verdicts when assertions is empty", () => {
    const result = aggregateAssertions([], { retrievedChunks: [chunk("c1", "doc-a")] });
    expect(result.status).toBe("recorded");
    expect(result.verdicts).toEqual([]);
    expect(result.reason).toBeNull();
  });

  it("returns 'pass' only when ALL assertions pass", () => {
    const result = aggregateAssertions(
      [
        { type: "retrieval_includes_document", documentId: "doc-A" },
        { type: "retrieval_excludes_document", documentId: "doc-stale" },
      ],
      { retrievedChunks: [chunk("c1", "doc-A"), chunk("c2", "doc-other")] },
    );
    expect(result.status).toBe("pass");
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.every((v) => v.status === "pass")).toBe(true);
  });

  it("returns 'fail' if any assertion fails and surfaces the failing reason", () => {
    const result = aggregateAssertions(
      [
        { type: "retrieval_includes_document", documentId: "doc-A" },
        { type: "retrieval_excludes_document", documentId: "doc-stale" },
      ],
      { retrievedChunks: [chunk("c1", "doc-A"), chunk("c2", "doc-stale")] },
    );
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("doc-stale");
  });

  it("returns 'error' if output carries an error, and marks every verdict as error", () => {
    const result = aggregateAssertions(
      [
        { type: "retrieval_includes_document", documentId: "doc-A" },
        { type: "retrieval_excludes_document", documentId: "doc-stale" },
      ],
      { retrievedChunks: [], error: { message: "embedding provider down" } },
    );
    expect(result.status).toBe("error");
    expect(result.reason).toBe("embedding provider down");
    expect(result.verdicts.every((v) => v.status === "error")).toBe(true);
  });
});
