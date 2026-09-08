import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  facetQualityQuestions,
  facetQualityTopicCount,
  type FacetQualityQuestion,
} from "../../fixtures/facet-quality/questions.js";
import { clusterDeterministically } from "../../support/deterministicKmeans.js";
import { adjustedRandIndex, normalizedMutualInformation } from "../../support/partitionAgreement.js";

/**
 * The gate for the audience topic census (spec 956).
 *
 * The design claims that extracting a normalized, PII-stripped facet before
 * embedding collapses both language and phrasing, so that clustering groups by
 * intent. This test measures that claim against hand-assigned topic labels, and
 * measures the same thing for the raw questions as a control. Only the
 * cross-lingual half of that claim is backed by a passing assertion here:
 * facets are not shown to improve overall topic recovery over the control
 * (see the threshold block below for why), but they are shown to keep a
 * cross-lingual paraphrase of one intent in a single cluster far more
 * reliably than the control does.
 *
 * Facets and embeddings are recorded by
 * `backend/scripts/dev/recordFacetQualityFixture.ts`, so this test is
 * deterministic and belongs in the unit eval suite rather than the live one.
 */

interface RecordedEntry {
  id: string;
  facetVector: number[];
  questionVector: number[];
}

interface RecordedFixture {
  promptVersion: string;
  extractionModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  entries: RecordedEntry[];
}

const recorded = JSON.parse(
  readFileSync(new URL("../../fixtures/facet-quality/recorded.json", import.meta.url), "utf8"),
) as RecordedFixture;

const recordedById = new Map(recorded.entries.map((entry) => [entry.id, entry]));

const CLUSTER_SEED = "facet-quality/956";

type VectorChoice = "facetVector" | "questionVector";

interface Scored {
  /** Cluster label per fixture question, in fixture order. */
  assignments: string[];
  overall: { ari: number; nmi: number; itemCount: number };
  multilingual: { ari: number; nmi: number; itemCount: number };
  /** Fraction of cross-lingual intent groups whose members all landed in one cluster. */
  crossLingualCohesion: number;
  /** Cross-lingual groups that split across clusters, for the failure report. */
  splitGroups: string[];
}

const labelled = facetQualityQuestions.filter(
  (entry): entry is FacetQualityQuestion & { topic: string } => entry.topic !== null,
);
const multilingual = labelled.filter((entry) => entry.crossLingualGroup !== undefined);

const scoreSubset = (
  subset: readonly (FacetQualityQuestion & { topic: string })[],
  clusterOf: Map<string, string>,
): { ari: number; nmi: number; itemCount: number } => {
  const predicted = subset.map((entry) => clusterOf.get(entry.id)!);
  const reference = subset.map((entry) => entry.topic);
  return {
    ari: adjustedRandIndex(predicted, reference),
    nmi: normalizedMutualInformation(predicted, reference),
    itemCount: subset.length,
  };
};

/**
 * Clusters the whole fixture — outliers included, because real traffic contains
 * them — then scores only the hand-labelled part against its reference topics.
 */
const score = (choice: VectorChoice, clusterCount = facetQualityTopicCount): Scored => {
  const items = facetQualityQuestions.map((entry) => ({
    id: entry.id,
    vector: recordedById.get(entry.id)![choice],
  }));
  const { assignments } = clusterDeterministically(items, { clusterCount, seed: CLUSTER_SEED });
  const labels = assignments.map((cluster) => `c${cluster}`);
  const clusterOf = new Map(facetQualityQuestions.map((entry, index) => [entry.id, labels[index]]));

  const groups = new Map<string, Set<string>>();
  for (const entry of multilingual) {
    const group = groups.get(entry.crossLingualGroup!) ?? new Set<string>();
    group.add(clusterOf.get(entry.id)!);
    groups.set(entry.crossLingualGroup!, group);
  }
  const splitGroups = [...groups.entries()].filter(([, clusters]) => clusters.size > 1).map(([name]) => name);

  return {
    assignments: labels,
    overall: scoreSubset(labelled, clusterOf),
    multilingual: scoreSubset(multilingual, clusterOf),
    crossLingualCohesion: groups.size === 0 ? 1 : (groups.size - splitGroups.length) / groups.size,
    splitGroups,
  };
};

const facets = score("facetVector");
const rawQuestions = score("questionVector");

const percent = (value: number): string => value.toFixed(3);

// A second, independently built hand labelling of the same 318 questions
// (reference B) is not reproduced in this report — including the
// facets-vs-raw ordering flip it exposes and the two-labeller agreement
// ceiling it establishes. See specs/956-audience-topic-census/eval-calibration.md.
const report = [
  "",
  `facet-quality gate — ${facetQualityQuestions.length} questions, ${facetQualityTopicCount} reference topics`,
  `  extraction ${recorded.extractionModel} @ ${recorded.promptVersion}`,
  `  embedding  ${recorded.embeddingModel} @ ${recorded.embeddingDimensions}d`,
  "",
  "  measure                        facets     raw questions",
  `  ARI  (all ${String(facets.overall.itemCount).padStart(3)} labelled)      ${percent(facets.overall.ari).padStart(6)}     ${percent(rawQuestions.overall.ari).padStart(6)}`,
  `  NMI  (all ${String(facets.overall.itemCount).padStart(3)} labelled)      ${percent(facets.overall.nmi).padStart(6)}     ${percent(rawQuestions.overall.nmi).padStart(6)}`,
  `  ARI  (multilingual ${String(facets.multilingual.itemCount).padStart(2)})       ${percent(facets.multilingual.ari).padStart(6)}     ${percent(rawQuestions.multilingual.ari).padStart(6)}`,
  `  NMI  (multilingual ${String(facets.multilingual.itemCount).padStart(2)})       ${percent(facets.multilingual.nmi).padStart(6)}     ${percent(rawQuestions.multilingual.nmi).padStart(6)}`,
  `  cross-lingual group cohesion   ${percent(facets.crossLingualCohesion).padStart(6)}     ${percent(rawQuestions.crossLingualCohesion).padStart(6)}`,
  `  split groups                   ${facets.splitGroups.join(",") || "none"}  |  ${rawQuestions.splitGroups.join(",") || "none"}`,
  "",
].join("\n");

/**
 * Facets are NOT shown to improve overall topic recovery over raw-question
 * embeddings. Whether facets or raw questions score higher on ARI/NMI flips
 * depending on which of two independent, competent hand labellings of the
 * same traffic is scored against — see
 * specs/956-audience-topic-census/eval-calibration.md. The only claim this
 * suite backs with a passing assertion is the cross-lingual one: facets put
 * one intent in one cluster regardless of the language it was asked in. The
 * overall-recovery floors below exist only to catch a pipeline regression,
 * not to certify topic quality.
 *
 * Thresholds. Two independent, competent labellings of the same 318 real
 * questions in this fixture agree with each other at only ARI 0.4923 / NMI
 * 0.6679 (eval-calibration.md) — that is the practical ceiling for this data:
 * no automated clustering should be expected to agree with one hand-picked
 * reference more than two competent humans agree with each other.
 * OVERALL_ARI_FLOOR = 0.15 and OVERALL_NMI_FLOOR = 0.30 sit at roughly 30%
 * and 45% of that ceiling, with margin below every one of the four measured
 * facets/raw x reference-A/B cells, so they catch an actual pipeline
 * regression without tripping on the reference-dependent swing already
 * observed between two hand labellings of the same, unchanged output.
 *
 * Do NOT raise these floors back toward 0.60. That number was calibrated
 * against a synthetic, cleanly-separated 8-topic fixture, not real traffic,
 * and it sits above the measured 0.4923 ceiling on this real, overlapping,
 * 12-topic data — no pipeline change can reach it, because it would require
 * beating the agreement level of two independent human labellers.
 *
 * The multilingual gate is deliberately the strict one, and is unchanged by
 * this recalibration. It is the claim the facet step exists to make, and the
 * subset is small enough that a single misplaced language drops ARI by
 * roughly 0.15, so 0.60 there tolerates one stray item and no more.
 */
const OVERALL_ARI_FLOOR = 0.15;
const OVERALL_NMI_FLOOR = 0.3;
const MULTILINGUAL_ARI_FLOOR = 0.6;
const CROSS_LINGUAL_COHESION_FLOOR = 0.75;
// Stricter bar for the cross-lingual-only claim below (measured 1.000):
// facets are expected to keep every cross-lingual intent group intact, not
// merely most of them.
const CROSS_LINGUAL_COHESION_STRICT_FLOOR = 0.85;

describe("facet quality gate", () => {
  it("reports facet and raw-question agreement with the hand-assigned topics", () => {
    process.stdout.write(report);
    expect(recorded.entries).toHaveLength(facetQualityQuestions.length);
  });

  it("recovers the hand-assigned topics from facet embeddings", () => {
    expect(facets.overall.ari).toBeGreaterThanOrEqual(OVERALL_ARI_FLOOR);
    expect(facets.overall.nmi).toBeGreaterThanOrEqual(OVERALL_NMI_FLOOR);
  });

  it("puts one intent in one cluster across four languages", () => {
    expect(facets.multilingual.ari).toBeGreaterThanOrEqual(MULTILINGUAL_ARI_FLOOR);
    expect(facets.crossLingualCohesion).toBeGreaterThanOrEqual(CROSS_LINGUAL_COHESION_FLOOR);
  });

  it("makes one intent land in one cluster regardless of the language it is asked in", () => {
    // This is the claim the facet call is paid for: not overall topic
    // recovery (see the threshold block above), but collapsing phrasing and
    // language so a cross-lingual paraphrase group stays in one cluster.
    expect(facets.crossLingualCohesion).toBeGreaterThanOrEqual(CROSS_LINGUAL_COHESION_STRICT_FLOOR);
    expect(facets.crossLingualCohesion).toBeGreaterThan(rawQuestions.crossLingualCohesion);
    expect(facets.multilingual.ari).toBeGreaterThanOrEqual(MULTILINGUAL_ARI_FLOOR);
  });

  it("clusters identically on repeated runs", () => {
    expect(score("facetVector").assignments).toEqual(facets.assignments);
  });
});
