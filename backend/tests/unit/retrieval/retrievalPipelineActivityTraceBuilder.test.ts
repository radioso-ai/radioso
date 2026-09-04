import { describe, expect, it } from "vitest";

import { RetrievalPipelineActivityTraceBuilder } from "../../../src/modules/retrieval/services/retrievalPipelineActivityTraceBuilder.js";
import type { ActivityTraceSourceStages } from "../../../src/modules/retrieval/services/retrievalPipelineActivityTraceBuilder.js";
import type { ActivityStage } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { activityTraceInputFixture } from "../../support/retrievalTraceFixtures.js";

const RETRIEVAL_STARTED_AT_MS = Date.parse("2026-04-12T14:14:16.030Z");

interface MeasuredRetrievalTimings {
  semanticRetrievalStartedAtMs?: number;
  semanticRetrievalDurationMs?: number;
  lexicalRetrievalStartedAtMs?: number;
  lexicalRetrievalDurationMs?: number;
}

// One subquery, so the assembler's per-branch averaging is the identity and the
// measured stage durations reach the trace unchanged.
const buildSourceStages = (
  measured: MeasuredRetrievalTimings,
  retrievalStageDurationMs: number,
): ActivityTraceSourceStages => {
  const fixture = activityTraceInputFixture();
  const prompt = {
    ...fixture.prompt,
    retrievalBranches: fixture.prompt.retrievalBranches.slice(0, 1),
    ...measured,
  };
  const measuredStage = <T>(result: T, startedAt: number, durationMs: number) => ({
    result,
    startedAt,
    durationMs,
  });

  return {
    traceStartedAtMs: RETRIEVAL_STARTED_AT_MS - 30,
    context: measuredStage(prompt, RETRIEVAL_STARTED_AT_MS - 30, 10),
    interpretation: measuredStage(prompt, RETRIEVAL_STARTED_AT_MS - 20, 20),
    retrieval: measuredStage(prompt, RETRIEVAL_STARTED_AT_MS, retrievalStageDurationMs),
    prepared: measuredStage(prompt, RETRIEVAL_STARTED_AT_MS + retrievalStageDurationMs, 20),
    selection: measuredStage(prompt, RETRIEVAL_STARTED_AT_MS + retrievalStageDurationMs + 20, 20),
    prompt: measuredStage(prompt, RETRIEVAL_STARTED_AT_MS + retrievalStageDurationMs + 40, 10),
    diagnostics: measuredStage(fixture.diagnostics, RETRIEVAL_STARTED_AT_MS + retrievalStageDurationMs + 50, 10),
  };
};

const stageTiming = (stages: ActivityStage[], kind: string): { startedAtMs: number; durationMs: number } => {
  const found = stages.find((stage) => stage.kind === kind);
  if (!found?.startedAt || found.durationMs === undefined) {
    throw new Error(`expected a timed ${kind} stage`);
  }
  return { startedAtMs: Date.parse(found.startedAt), durationMs: found.durationMs };
};

describe("retrieval pipeline activity trace builder", () => {
  it("reports the measured semantic and lexical durations", () => {
    const retrievalStageDurationMs = 1_000;
    const trace = new RetrievalPipelineActivityTraceBuilder().buildActivityTrace(
      buildSourceStages(
        {
          lexicalRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS + 5,
          lexicalRetrievalDurationMs: 40,
          semanticRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS + 90,
          semanticRetrievalDurationMs: 900,
        },
        retrievalStageDurationMs,
      ),
    );

    const semantic = stageTiming(trace.stages, "semantic_rewritten");
    const lexical = stageTiming(trace.stages, "lexical");

    expect(semantic.durationMs).toBe(900);
    expect(lexical.durationMs).toBe(40);
    // A proportional split of the retrieval span would report 650/350 here.
    expect(lexical.durationMs).toBeLessThan(Math.round(retrievalStageDurationMs * 0.35));
    expect(semantic.startedAtMs).toBe(RETRIEVAL_STARTED_AT_MS + 90);
    expect(lexical.startedAtMs).toBe(RETRIEVAL_STARTED_AT_MS + 5);
  });

  it("represents overlapping semantic and lexical work", () => {
    const retrievalStageDurationMs = 950;
    const semanticRetrievalDurationMs = 860;
    const lexicalRetrievalDurationMs = 700;
    const trace = new RetrievalPipelineActivityTraceBuilder().buildActivityTrace(
      buildSourceStages(
        {
          lexicalRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS,
          lexicalRetrievalDurationMs,
          semanticRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS + 90,
          semanticRetrievalDurationMs,
        },
        retrievalStageDurationMs,
      ),
    );

    const semantic = stageTiming(trace.stages, "semantic_rewritten");
    const lexical = stageTiming(trace.stages, "lexical");

    // Concurrent branches: lexical starts first and the two durations together
    // exceed the span that contains both.
    expect(lexical.startedAtMs).toBeLessThan(semantic.startedAtMs);
    expect(lexical.durationMs + semantic.durationMs).toBeGreaterThan(retrievalStageDurationMs);
    expect(lexical.startedAtMs).toBe(RETRIEVAL_STARTED_AT_MS);
    expect(lexical.startedAtMs).not.toBe(RETRIEVAL_STARTED_AT_MS + semanticRetrievalDurationMs);
  });

  it("reports zero duration for a branch that did not run", () => {
    const trace = new RetrievalPipelineActivityTraceBuilder().buildActivityTrace(
      buildSourceStages(
        {
          lexicalRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS,
          lexicalRetrievalDurationMs: 120,
          semanticRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS,
          semanticRetrievalDurationMs: 0,
        },
        120,
      ),
    );

    expect(stageTiming(trace.stages, "semantic_rewritten").durationMs).toBe(0);
    expect(stageTiming(trace.stages, "lexical").durationMs).toBe(120);
  });

  it("reports a zero-length span at the stage start when a branch was not measured", () => {
    const stages = buildSourceStages(
      {
        semanticRetrievalStartedAtMs: RETRIEVAL_STARTED_AT_MS + 40,
        semanticRetrievalDurationMs: 900,
        lexicalRetrievalStartedAtMs: undefined,
        lexicalRetrievalDurationMs: undefined,
      },
      1_000,
    );

    const trace = new RetrievalPipelineActivityTraceBuilder().buildActivityTrace(stages);
    const lexical = stageTiming(trace.stages, "lexical");

    // Never a share of the enclosing stage: a derived split reads as a real measurement.
    expect(lexical.durationMs).toBe(0);
    expect(lexical.startedAtMs).toBe(RETRIEVAL_STARTED_AT_MS);
    expect(stageTiming(trace.stages, "semantic_rewritten").durationMs).toBe(900);
  });
});
