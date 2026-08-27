import { describe, expect, it } from "vitest";

import {
  compareRankings,
  evaluateParity,
  minimumRequiredProbes,
  summarizeParity,
} from "../../../scripts/canonicalVectorParity.js";
import { legacyEmbeddingExpressionForDimensions } from "../../../scripts/canonicalVectorParityRunner.js";

// Retiring chunks.embedding is gated on the canonical leg returning what the legacy
// leg returns. These helpers own what "returns the same thing" means, so the gate is
// a tested definition rather than a judgement made while reading a console dump.

const ranked = (entries: Array<[string, number]>) =>
  entries.map(([chunkId, score]) => ({ chunkId, score }));

describe("compareRankings", () => {
  it("uses the wide legacy projection for non-1536 parity probes", () => {
    expect(legacyEmbeddingExpressionForDimensions(1536)).toBe("c.embedding");
    expect(legacyEmbeddingExpressionForDimensions(3072))
      .toBe("COALESCE(c.embedding_unbounded, c.embedding)");
  });

  it("reports full recall when the candidate returns every reference chunk", () => {
    const comparison = compareRankings({
      reference: ranked([["a", 0.9], ["b", 0.8]]),
      candidate: ranked([["a", 0.9], ["b", 0.8]]),
      topK: 10,
    });

    expect(comparison.recall).toBe(1);
    expect(comparison.missingFromCandidate).toEqual([]);
    expect(comparison.extraInCandidate).toEqual([]);
    expect(comparison.topMatch).toBe(true);
  });

  it("names the reference chunks the candidate dropped, worst case first", () => {
    // These are the chunks that become unreachable once the legacy leg is removed,
    // so the identifiers matter more than the ratio when the gate fails.
    const comparison = compareRankings({
      reference: ranked([["a", 0.9], ["b", 0.8], ["c", 0.7]]),
      candidate: ranked([["b", 0.8]]),
      topK: 10,
    });

    expect(comparison.missingFromCandidate).toEqual(["a", "c"]);
    expect(comparison.recall).toBeCloseTo(1 / 3);
    expect(comparison.topMatch).toBe(false);
  });

  it("does not penalise the candidate for finding chunks the reference missed", () => {
    // Canonical covers widths and revisions the legacy column cannot, so extra hits
    // are expected. Recall is one-directional on purpose.
    const comparison = compareRankings({
      reference: ranked([["a", 0.9]]),
      candidate: ranked([["a", 0.9], ["z", 0.5]]),
      topK: 10,
    });

    expect(comparison.recall).toBe(1);
    expect(comparison.extraInCandidate).toEqual(["z"]);
  });

  it("compares only the first topK of each leg", () => {
    const comparison = compareRankings({
      reference: ranked([["a", 0.9], ["b", 0.8], ["c", 0.7]]),
      candidate: ranked([["a", 0.9], ["b", 0.8], ["c", 0.7]]),
      topK: 2,
    });

    expect(comparison.referenceCount).toBe(2);
    expect(comparison.candidateCount).toBe(2);
    expect(comparison.recall).toBe(1);
  });

  it("treats an empty reference as nothing to lose", () => {
    const comparison = compareRankings({
      reference: [],
      candidate: ranked([["a", 0.9]]),
      topK: 10,
    });

    expect(comparison.recall).toBe(1);
    expect(comparison.topMatch).toBe(true);
  });

  it("measures the largest score disagreement over the chunks both legs returned", () => {
    // A shared chunk scored differently means the two legs hold different vectors for
    // it — a re-embed under a different model, not an index artefact.
    const comparison = compareRankings({
      reference: ranked([["a", 0.90], ["b", 0.80]]),
      candidate: ranked([["a", 0.88], ["b", 0.50]]),
      topK: 10,
    });

    expect(comparison.maxScoreDelta).toBeCloseTo(0.3);
  });

  it("reports no score disagreement when the legs share nothing", () => {
    const comparison = compareRankings({
      reference: ranked([["a", 0.9]]),
      candidate: ranked([["z", 0.1]]),
      topK: 10,
    });

    expect(comparison.maxScoreDelta).toBe(0);
    expect(comparison.recall).toBe(0);
  });
});

describe("summarizeParity", () => {
  it("aggregates recall and counts the distinct chunks at risk", () => {
    const summary = summarizeParity([
      compareRankings({
        reference: ranked([["a", 0.9], ["b", 0.8]]),
        candidate: ranked([["a", 0.9], ["b", 0.8]]),
        topK: 10,
      }),
      compareRankings({
        reference: ranked([["a", 0.9], ["b", 0.8]]),
        candidate: ranked([["a", 0.9]]),
        topK: 10,
      }),
      compareRankings({
        reference: ranked([["b", 0.7], ["c", 0.6]]),
        candidate: ranked([["c", 0.6]]),
        topK: 10,
      }),
    ]);

    expect(summary.probes).toBe(3);
    expect(summary.meanRecall).toBeCloseTo((1 + 0.5 + 0.5) / 3);
    expect(summary.worstProbeRecall).toBe(0.5);
    expect(summary.probesWithMissingChunks).toBe(2);
    // "b" is dropped by two probes but is one chunk.
    expect(summary.distinctMissingChunks).toBe(1);
  });

  it("counts the probes whose reference leg returned nothing", () => {
    const summary = summarizeParity([
      compareRankings({ reference: [], candidate: ranked([["a", 0.9]]), topK: 10 }),
      compareRankings({
        reference: ranked([["a", 0.9]]),
        candidate: ranked([["a", 0.9]]),
        topK: 10,
      }),
    ])

    expect(summary.probesWithEmptyReference).toBe(1)
    expect(summary.meanRecall).toBe(1)
  })

  it("reports a perfect summary for zero probes rather than dividing by zero", () => {
    const summary = summarizeParity([]);

    expect(summary.probes).toBe(0);
    expect(summary.meanRecall).toBe(1);
    expect(summary.worstProbeRecall).toBe(1);
    expect(summary.distinctMissingChunks).toBe(0);
  });
});

describe("evaluateParity", () => {
  const perfect = summarizeParity([
    compareRankings({
      reference: ranked([["a", 0.9]]),
      candidate: ranked([["a", 0.9]]),
      topK: 10,
    }),
  ]);

  it("passes when every threshold is met", () => {
    expect(evaluateParity(perfect, {
      minMeanRecall: 0.99,
      minWorstProbeRecall: 0.9,
      minProbes: 1,
    })).toEqual({ passed: true, failures: [] });
  });

  it("fails a summary built from too few probes", () => {
    // A high mean over three probes says nothing; without a probe floor the gate
    // would pass on a workspace it never really sampled.
    const verdict = evaluateParity(perfect, {
      minMeanRecall: 0.99,
      minWorstProbeRecall: 0.9,
      minProbes: 20,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toContain("probes");
  });

  it("fails a run where every reference ranking was empty", () => {
    // Recall over an empty reference is 1 by definition, so a misconfigured run — wrong
    // embedding space, a model label the legacy rows do not carry — would otherwise
    // report perfect parity having compared nothing at all.
    const summary = summarizeParity([
      compareRankings({ reference: [], candidate: ranked([["a", 0.9]]), topK: 10 }),
      compareRankings({ reference: [], candidate: ranked([["b", 0.8]]), topK: 10 }),
    ]);

    const verdict = evaluateParity(summary, {
      minMeanRecall: 0.99,
      minWorstProbeRecall: 0.9,
      minProbes: 1,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toContain("returned nothing");
  });

  it("does not let empty-reference probes satisfy the probe floor", () => {
    const summary = summarizeParity([
      compareRankings({ reference: [], candidate: ranked([["a", 0.9]]), topK: 10 }),
      compareRankings({
        reference: ranked([["b", 0.8]]),
        candidate: ranked([["b", 0.8]]),
        topK: 10,
      }),
    ]);

    expect(evaluateParity(summary, {
      minMeanRecall: 0.99,
      minWorstProbeRecall: 0.9,
      minProbes: 2,
    })).toMatchObject({
      passed: false,
      failures: [expect.stringContaining("non-empty reference")],
    });
  });

  it("fails when canonical drops a known legacy result despite permissive recall floors", () => {
    const summary = summarizeParity([
      compareRankings({
        reference: ranked([["a", 0.9], ["b", 0.8]]),
        candidate: ranked([["a", 0.9]]),
        topK: 10,
      }),
    ]);

    const verdict = evaluateParity(summary, {
      minMeanRecall: 0,
      minWorstProbeRecall: 0,
      minProbes: 1,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain("canonical missed 1 distinct reference chunk(s)");
  });

  it("fails when canonical changes the top result without dropping a result", () => {
    const summary = summarizeParity([
      compareRankings({
        reference: ranked([["a", 0.9], ["b", 0.8]]),
        candidate: ranked([["b", 0.95], ["a", 0.9]]),
        topK: 10,
      }),
    ]);

    const verdict = evaluateParity(summary, {
      minMeanRecall: 0,
      minWorstProbeRecall: 0,
      minProbes: 1,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain("top-1 agreement 0.00% is below 100.00%");
  });

  it("fails when a single probe drops below the worst-case floor", () => {
    const summary = summarizeParity([
      compareRankings({
        reference: ranked([["a", 0.9]]),
        candidate: ranked([["a", 0.9]]),
        topK: 10,
      }),
      compareRankings({
        reference: ranked([["a", 0.9], ["b", 0.8]]),
        candidate: ranked([["a", 0.9]]),
        topK: 10,
      }),
    ]);

    const verdict = evaluateParity(summary, {
      minMeanRecall: 0.7,
      minWorstProbeRecall: 0.9,
      minProbes: 1,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual([
      expect.stringContaining("worst-probe recall"),
      "canonical missed 1 distinct reference chunk(s)",
    ]);
  });
});

describe("minimumRequiredProbes", () => {
  it("bounds the configured floor by the eligible population", () => {
    expect(minimumRequiredProbes(30, 5)).toBe(5);
    expect(minimumRequiredProbes(30, 100)).toBe(30);
  });

  it("makes a workspace with no eligible chunks explicitly zero-risk", () => {
    expect(minimumRequiredProbes(30, 0)).toBe(0);
    expect(evaluateParity(summarizeParity([]), {
      minMeanRecall: 0.99,
      minWorstProbeRecall: 0.9,
      minProbes: minimumRequiredProbes(30, 0),
    })).toEqual({ passed: true, failures: [] });
  });
});
