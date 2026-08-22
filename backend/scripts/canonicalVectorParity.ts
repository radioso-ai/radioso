// What "the canonical leg returns the same thing" means, expressed once.
//
// Retiring `chunks.embedding` is gated on the canonical leg answering as well as the
// legacy one. The same comparison serves a second question the migration needs an
// answer to: production builds its HNSW graph incrementally as rows arrive, so the
// index's recall against an exact scan of the same table has to be measured where it
// was built, not inferred from a bulk-built benchmark. Both are "does this ranking
// contain what that ranking contained", so both use these helpers — the reference is
// the leg being retired in one case and the exact scan in the other.

export interface RankedCandidate {
  readonly chunkId: string;
  readonly score: number;
}

export interface RankingComparison {
  readonly referenceCount: number;
  readonly candidateCount: number;
  /**
   * Share of the reference ranking the candidate also returned. One-directional: a
   * candidate that returns more than the reference is not penalised, because
   * canonical legitimately covers revisions and widths the legacy column cannot.
   */
  readonly recall: number;
  /** Reference chunks the candidate dropped, in reference rank order. */
  readonly missingFromCandidate: readonly string[];
  readonly extraInCandidate: readonly string[];
  /** Largest score disagreement over chunks both legs returned; 0 when they share none. */
  readonly maxScoreDelta: number;
  readonly topMatch: boolean;
}

export interface ParitySummary {
  readonly probes: number;
  readonly meanRecall: number;
  readonly worstProbeRecall: number;
  readonly probesWithMissingChunks: number;
  readonly distinctMissingChunks: number;
  /**
   * Probes whose reference leg returned nothing. Their recall is 1 by definition, so
   * this is what separates real agreement from a comparison that had nothing to compare.
   */
  readonly probesWithEmptyReference: number;
  readonly maxScoreDelta: number;
  readonly topMatchRate: number;
}

export interface ParityThresholds {
  readonly minMeanRecall: number;
  readonly minWorstProbeRecall: number;
  readonly minProbes: number;
}

export interface ParityVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export const compareRankings = (input: {
  reference: readonly RankedCandidate[];
  candidate: readonly RankedCandidate[];
  topK: number;
}): RankingComparison => {
  const reference = input.reference.slice(0, input.topK);
  const candidate = input.candidate.slice(0, input.topK);
  const candidateScores = new Map(
    candidate.map((entry) => [entry.chunkId, entry.score]),
  );
  const referenceIds = new Set(reference.map((entry) => entry.chunkId));

  const missingFromCandidate: string[] = [];
  let maxScoreDelta = 0;
  for (const entry of reference) {
    const candidateScore = candidateScores.get(entry.chunkId);
    if (candidateScore === undefined) {
      missingFromCandidate.push(entry.chunkId);
      continue;
    }
    maxScoreDelta = Math.max(maxScoreDelta, Math.abs(entry.score - candidateScore));
  }

  return {
    referenceCount: reference.length,
    candidateCount: candidate.length,
    // An empty reference is not a failure to reproduce: there was nothing to lose.
    recall: reference.length === 0
      ? 1
      : (reference.length - missingFromCandidate.length) / reference.length,
    missingFromCandidate,
    extraInCandidate: candidate
      .filter((entry) => !referenceIds.has(entry.chunkId))
      .map((entry) => entry.chunkId),
    maxScoreDelta,
    // An empty reference has no best result to reproduce, so it counts as agreement
    // for the same reason its recall is 1 — otherwise probes that legitimately match
    // nothing on the leg being retired would drag the rate down.
    topMatch: reference.length === 0
      || reference[0]?.chunkId === candidate[0]?.chunkId,
  };
};

export const summarizeParity = (
  comparisons: readonly RankingComparison[],
): ParitySummary => {
  if (comparisons.length === 0) {
    return {
      probes: 0,
      meanRecall: 1,
      worstProbeRecall: 1,
      probesWithMissingChunks: 0,
      distinctMissingChunks: 0,
      probesWithEmptyReference: 0,
      maxScoreDelta: 0,
      topMatchRate: 1,
    };
  }

  const missingChunks = new Set<string>();
  let recallTotal = 0;
  let worstProbeRecall = 1;
  let probesWithMissingChunks = 0;
  let probesWithEmptyReference = 0;
  let maxScoreDelta = 0;
  let topMatches = 0;
  for (const comparison of comparisons) {
    recallTotal += comparison.recall;
    if (comparison.referenceCount === 0) {
      probesWithEmptyReference += 1;
    }
    worstProbeRecall = Math.min(worstProbeRecall, comparison.recall);
    maxScoreDelta = Math.max(maxScoreDelta, comparison.maxScoreDelta);
    if (comparison.missingFromCandidate.length > 0) {
      probesWithMissingChunks += 1;
      for (const chunkId of comparison.missingFromCandidate) {
        missingChunks.add(chunkId);
      }
    }
    if (comparison.topMatch) {
      topMatches += 1;
    }
  }

  return {
    probes: comparisons.length,
    meanRecall: recallTotal / comparisons.length,
    worstProbeRecall,
    probesWithMissingChunks,
    // Probes overlap heavily, so the same chunk is dropped by many of them. The
    // distinct count is what "how much becomes unreachable" actually costs.
    distinctMissingChunks: missingChunks.size,
    probesWithEmptyReference,
    maxScoreDelta,
    topMatchRate: topMatches / comparisons.length,
  };
};

export const evaluateParity = (
  summary: ParitySummary,
  thresholds: ParityThresholds,
): ParityVerdict => {
  const failures: string[] = [];
  const comparableProbes = summary.probes - summary.probesWithEmptyReference;
  // A high mean over a handful of probes says nothing about a workspace with
  // thousands of chunks. Empty reference rankings carry no parity evidence and
  // therefore cannot pad this floor.
  if (comparableProbes < thresholds.minProbes) {
    failures.push(
      `sampled ${comparableProbes} probes with a non-empty reference, below the `
      + `${thresholds.minProbes} required`,
    );
  }
  // Recall over an empty reference is 1 by definition. If that held for every probe the
  // run compared nothing, and the likeliest cause is a misconfigured comparison — the
  // wrong embedding space, or a model label the reference rows do not carry — not a
  // reference leg that is genuinely empty.
  if (summary.probes > 0 && summary.probesWithEmptyReference === summary.probes) {
    failures.push(
      `every one of ${summary.probes} probes returned nothing on the reference leg, `
      + "so nothing was compared",
    );
  }
  if (summary.meanRecall < thresholds.minMeanRecall) {
    failures.push(
      `mean recall ${formatRatio(summary.meanRecall)} is below `
      + `${formatRatio(thresholds.minMeanRecall)}`,
    );
  }
  if (summary.worstProbeRecall < thresholds.minWorstProbeRecall) {
    failures.push(
      `worst-probe recall ${formatRatio(summary.worstProbeRecall)} is below `
      + `${formatRatio(thresholds.minWorstProbeRecall)}`,
    );
  }
  // This gate authorizes deleting the fallback. Aggregate recall thresholds remain
  // useful diagnostics, but no aggregate can make a known lost result safe to delete.
  if (summary.distinctMissingChunks > 0) {
    failures.push(
      `canonical missed ${summary.distinctMissingChunks} distinct reference chunk(s)`,
    );
  }
  if (summary.topMatchRate < 1) {
    failures.push(
      `top-1 agreement ${formatRatio(summary.topMatchRate)} is below ${formatRatio(1)}`,
    );
  }
  return { passed: failures.length === 0, failures };
};

export const minimumRequiredProbes = (
  configuredMinimum: number,
  eligiblePopulation: number,
): number => Math.min(configuredMinimum, eligiblePopulation);

export const formatRatio = (value: number): string => `${(value * 100).toFixed(2)}%`;
