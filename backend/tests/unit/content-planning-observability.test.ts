import { describe, expect, it, vi } from "vitest";

import {
  ContentPlanningWorkerObservability,
  type ContentPlanWorkerEvent,
} from "../../src/modules/contentPlanning/worker.js";

const QUESTION = "QUESTION-CONTENT-CANARY";
const VECTOR = "VECTOR-CONTENT-CANARY";
const LABEL = "LABEL-CONTENT-CANARY";
const RECOMMENDATION = "RECOMMENDATION-CONTENT-CANARY";
const DOCUMENT = "DOCUMENT-CONTENT-CANARY";
const PROMPT = "PROMPT-CONTENT-CANARY";
const COMPLETION = "COMPLETION-CONTENT-CANARY";
const PROVIDER_BODY = "PROVIDER-BODY-CONTENT-CANARY";
const HIGH_CARDINALITY_LABEL = "HIGH-CARDINALITY-LABEL-CANARY";

const createHarness = (
  options?: ConstructorParameters<typeof ContentPlanningWorkerObservability>[1],
) => {
  const logs: Array<{ level: "info" | "warn"; fields: ContentPlanWorkerEvent; message: string }> = [];
  const counters: Array<{
    name: string;
    options: { help: string; labels: Record<string, string>; value?: number };
  }> = [];
  const histograms: Array<{
    name: string;
    options: { help: string; labels: Record<string, string>; value: number };
  }> = [];
  const gauges: Array<{
    name: string;
    options: { help: string; labels: Record<string, string>; value: number };
  }> = [];
  const traces: Array<{ name: string; attributes: Record<string, string | number> }> = [];
  const analytics = vi.fn();
  const sinks = {
    logger: {
      info: (fields: ContentPlanWorkerEvent, message: string) => logs.push({ level: "info", fields, message }),
      warn: (fields: ContentPlanWorkerEvent, message: string) => logs.push({ level: "warn", fields, message }),
    },
    metrics: {
      incrementCounter: (
        name: string,
        options: { help: string; labels: Record<string, string>; value?: number },
      ) => counters.push({ name, options }),
      observeHistogram: (
        name: string,
        options: { help: string; labels: Record<string, string>; value: number },
      ) => histograms.push({ name, options }),
      setGauge: (
        name: string,
        options: { help: string; labels: Record<string, string>; value: number },
      ) => gauges.push({ name, options }),
    },
    tracer: {
      record: (name: string, attributes: Record<string, string | number>) => traces.push({ name, attributes }),
    },
    analytics: { track: analytics },
  };
  return {
    observability: new ContentPlanningWorkerObservability(sinks, options),
    logs,
    counters,
    histograms,
    gauges,
    traces,
    analytics,
  };
};

describe("ContentPlanningWorkerObservability privacy policy", () => {
  it("allowlists safe log/span fields and uses only bounded metric labels", () => {
    const harness = createHarness();
    const event = {
      stage: "embedding",
      outcome: "retry_scheduled",
      reason: "embedding_provider_failed",
      workspaceId: "workspace-safe-id",
      generationId: "generation-safe-id",
      observationId: "observation-safe-id",
      topicId: "topic-safe-id",
      attemptCount: 2,
      itemCount: 3,
      durationMs: 17,
      vectorSource: "fallback",
      assignmentOutcome: "existing",
      lifecycle: "mature",
      revision: 4,
      questionText: QUESTION,
      vector: [VECTOR],
      label: LABEL,
      recommendation: RECOMMENDATION,
      documentContent: DOCUMENT,
      prompt: PROMPT,
      completion: COMPLETION,
      providerBody: PROVIDER_BODY,
      labels: { topic: HIGH_CARDINALITY_LABEL },
    } as ContentPlanWorkerEvent & Record<string, unknown>;

    harness.observability.record(event);

    expect(harness.logs).toEqual([{
      level: "warn",
      message: "content_planning_worker_event",
      fields: {
        stage: "embedding",
        outcome: "retry_scheduled",
        reason: "embedding_provider_failed",
        workspaceId: "workspace-safe-id",
        generationId: "generation-safe-id",
        observationId: "observation-safe-id",
        topicId: "topic-safe-id",
        attemptCount: 2,
        itemCount: 3,
        durationMs: 17,
        vectorSource: "fallback",
        assignmentOutcome: "existing",
        lifecycle: "mature",
        revision: 4,
      },
    }]);
    const boundedLabels = {
      stage: "embedding",
      outcome: "retry_scheduled",
      reason: "embedding_provider_failed",
      vector_source: "fallback",
      assignment_outcome: "existing",
      lifecycle: "mature",
    };
    expect(harness.counters).toEqual([expect.objectContaining({
      name: "content_planning_worker_events_total",
      options: expect.objectContaining({ labels: boundedLabels, value: 3 }),
    })]);
    expect(harness.histograms).toEqual([expect.objectContaining({
      name: "content_planning_worker_stage_duration_ms",
      options: expect.objectContaining({ labels: boundedLabels, value: 17 }),
    })]);
    expect(harness.traces).toEqual([{
      name: "content_planning.worker.embedding",
      attributes: {
        "content_plan.stage": "embedding",
        "content_plan.outcome": "retry_scheduled",
        "content_plan.reason": "embedding_provider_failed",
        "content_plan.workspace_id": "workspace-safe-id",
        "content_plan.generation_id": "generation-safe-id",
        "content_plan.observation_id": "observation-safe-id",
        "content_plan.topic_id": "topic-safe-id",
        "content_plan.attempt_count": 2,
        "content_plan.item_count": 3,
        "content_plan.duration_ms": 17,
        "content_plan.vector_source": "fallback",
        "content_plan.assignment_outcome": "existing",
        "content_plan.lifecycle": "mature",
        "content_plan.revision": 4,
      },
    }]);
    expect(harness.analytics).not.toHaveBeenCalled();

    const serialized = JSON.stringify(harness);
    for (const canary of [
      QUESTION,
      VECTOR,
      LABEL,
      RECOMMENDATION,
      DOCUMENT,
      PROMPT,
      COMPLETION,
      PROVIDER_BODY,
      HIGH_CARDINALITY_LABEL,
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("drops invalid optional enum values and suppresses events with invalid required enums", () => {
    const harness = createHarness();

    harness.observability.record({
      stage: "embedding",
      outcome: "retry_scheduled",
      reason: PROVIDER_BODY,
      vectorSource: QUESTION,
      assignmentOutcome: LABEL,
      lifecycle: RECOMMENDATION,
    } as unknown as ContentPlanWorkerEvent);
    harness.observability.record({
      stage: PROMPT,
      outcome: COMPLETION,
    } as unknown as ContentPlanWorkerEvent);

    expect(harness.logs).toEqual([{
      level: "warn",
      message: "content_planning_worker_event",
      fields: { stage: "embedding", outcome: "retry_scheduled" },
    }]);
    expect(harness.counters).toHaveLength(1);
    expect(harness.counters[0]?.options.labels).toEqual({
      stage: "embedding",
      outcome: "retry_scheduled",
      reason: "none",
      vector_source: "none",
      assignment_outcome: "none",
      lifecycle: "none",
    });
    expect(harness.traces).toEqual([{
      name: "content_planning.worker.embedding",
      attributes: {
        "content_plan.stage": "embedding",
        "content_plan.outcome": "retry_scheduled",
      },
    }]);
    const serialized = JSON.stringify(harness);
    for (const canary of [PROVIDER_BODY, QUESTION, LABEL, RECOMMENDATION, PROMPT, COMPLETION]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("records bounded projection backlog, progress, topic, and provider metrics without identifier labels", () => {
    const harness = createHarness();

    harness.observability.record({
      stage: "projection_snapshot",
      outcome: "progressed",
      workspaceId: "workspace-safe-id",
      generationId: "generation-safe-id",
      durationMs: 41,
      projectionKind: "bootstrap",
      projectionState: "bootstrapping",
      processedCount: 25,
      totalCount: 100,
      projectionLagSeconds: 93,
      pendingObservationCount: 11,
      pendingEmbeddingCount: 4,
      pendingAssignmentCount: 5,
      pendingEnrichmentCount: 2,
      provisionalTopicCount: 7,
      matureTopicCount: 13,
      mergedTopicCount: 3,
    });
    harness.observability.record({
      stage: "enrichment",
      outcome: "completed",
      workspaceId: "workspace-safe-id",
      generationId: "generation-safe-id",
      topicId: "topic-safe-id",
      durationMs: 73,
      providerOperation: "content_brief",
      providerCallCount: 1,
    });
    harness.observability.record({
      stage: "enrichment",
      outcome: "published",
      workspaceId: "workspace-safe-id",
      generationId: "generation-safe-id",
      topicId: "topic-safe-id",
      durationMs: 80,
    });

    expect(harness.gauges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "content_planning_projection_progress_ratio",
        options: expect.objectContaining({
          labels: { projection_kind: "bootstrap", projection_state: "bootstrapping" },
          value: 0.25,
        }),
      }),
      expect.objectContaining({
        name: "content_planning_projection_lag_seconds",
        options: expect.objectContaining({
          labels: { projection_state: "bootstrapping" },
          value: 93,
        }),
      }),
      expect.objectContaining({
        name: "content_planning_pending_observations",
        options: expect.objectContaining({
          labels: { projection_state: "bootstrapping" },
          value: 11,
        }),
      }),
      ...[
        ["embedding", 4],
        ["assignment", 5],
        ["enrichment", 2],
      ].map(([backlog, value]) => expect.objectContaining({
        name: "content_planning_projection_backlog",
        options: expect.objectContaining({
          labels: { backlog, projection_state: "bootstrapping" },
          value,
        }),
      })),
      ...[
        ["provisional", 7],
        ["mature", 13],
        ["merged", 3],
      ].map(([lifecycle, value]) => expect.objectContaining({
        name: "content_planning_topic_count",
        options: expect.objectContaining({ labels: { lifecycle }, value }),
      })),
      expect.objectContaining({
        name: "content_planning_topic_merge_count",
        options: expect.objectContaining({ labels: {}, value: 3 }),
      }),
    ]));
    expect(harness.histograms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "content_planning_enrichment_latency_ms",
        options: expect.objectContaining({ labels: { outcome: "published" }, value: 80 }),
      }),
    ]));
    expect(harness.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "content_planning_provider_calls_total",
        options: expect.objectContaining({
          labels: { operation: "content_brief", outcome: "completed" },
          value: 1,
        }),
      }),
      expect.objectContaining({
        name: "content_planning_enrichment_outcomes_total",
        options: expect.objectContaining({
          labels: { outcome: "published", reason: "none" },
        }),
      }),
    ]));

    for (const metric of [...harness.counters, ...harness.histograms, ...harness.gauges]) {
      expect(metric.options.labels).not.toHaveProperty("workspace_id");
      expect(metric.options.labels).not.toHaveProperty("generation_id");
      expect(metric.options.labels).not.toHaveProperty("topic_id");
    }
  });

  it("evicts expired operational snapshots and caps aggregate workspace state", () => {
    let nowMs = 0;
    const harness = createHarness({
      clock: () => nowMs,
      projectionSnapshotTtlMs: 1_000,
      maxProjectionSnapshots: 1,
    });
    const snapshot = (workspaceId: string, provisionalTopicCount: number) => ({
      stage: "projection_snapshot" as const,
      outcome: "completed" as const,
      workspaceId,
      generationId: `generation_${workspaceId}`,
      projectionKind: "bootstrap" as const,
      projectionState: "ready" as const,
      pendingObservationCount: 0,
      pendingEmbeddingCount: 0,
      pendingAssignmentCount: 0,
      pendingEnrichmentCount: 0,
      provisionalTopicCount,
      matureTopicCount: 0,
      mergedTopicCount: 0,
    });

    harness.observability.record(snapshot("workspace_1", 7));
    nowMs = 500;
    harness.observability.record(snapshot("workspace_2", 3));
    nowMs = 1_501;
    harness.observability.record(snapshot("workspace_3", 2));

    const provisionalGauges = harness.gauges.filter((metric) =>
      metric.name === "content_planning_topic_count"
      && metric.options.labels.lifecycle === "provisional");
    expect(provisionalGauges.at(-1)?.options.value).toBe(2);
  });

  it("counts embedding reuse/fallback and assignment outcomes only from completed assignments", () => {
    const harness = createHarness();
    harness.observability.record({
      stage: "embedding",
      outcome: "completed",
      vectorSource: "fallback",
      providerOperation: "embedding",
      providerCallCount: 1,
    });
    harness.observability.record({
      stage: "assignment",
      outcome: "created_topic",
      vectorSource: "reused",
      assignmentOutcome: "created",
      lifecycle: "provisional",
    });

    expect(harness.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "content_planning_embedding_vectors_total",
        options: expect.objectContaining({ labels: { vector_source: "reused" }, value: 1 }),
      }),
      expect.objectContaining({
        name: "content_planning_assignment_outcomes_total",
        options: expect.objectContaining({
          labels: { assignment_outcome: "created", lifecycle: "provisional" },
          value: 1,
        }),
      }),
    ]));
    expect(harness.counters.filter((metric) =>
      metric.name === "content_planning_embedding_vectors_total"))
      .toHaveLength(1);
  });
});
