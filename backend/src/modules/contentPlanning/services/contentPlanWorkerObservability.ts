export type ContentPlanWorkerStage =
  | "claim"
  | "source"
  | "embedding"
  | "assignment"
  | "reconciliation"
  | "retention"
  | "discovery"
  | "bootstrap"
  | "reprojection"
  | "projection_snapshot"
  | "corpus_invalidation"
  | "enrichment_schedule"
  | "enrichment";

export type ContentPlanWorkerOutcome =
  | "claimed"
  | "completed"
  | "retry_scheduled"
  | "terminal_failure"
  | "stale"
  | "skipped"
  | "created_topic"
  | "assigned_existing"
  | "matured"
  | "retired"
  | "budget_paused"
  | "progressed"
  | "awaiting_projection"
  | "promoted"
  | "up_to_date"
  | "busy"
  | "published";

export type ContentPlanWorkerFailureReason =
  | "lease_expired"
  | "missing_claim_token"
  | "invalid_claim_state"
  | "claim_repository_failed"
  | "source_load_failed"
  | "source_unavailable"
  | "semantic_intent_missing"
  | "semantic_hash_mismatch"
  | "semantic_intent_ambiguous"
  | "embedding_budget_reservation_failed"
  | "embedding_budget_paused"
  | "embedding_provider_failed"
  | "embedding_result_count_mismatch"
  | "embedding_space_mismatch"
  | "embedding_vector_invalid"
  | "claim_settlement_failed"
  | "assignment_evidence_unavailable"
  | "assignment_conflict"
  | "assignment_repository_failed"
  | "reconciliation_evidence_unavailable"
  | "reconciliation_conflict"
  | "reconciliation_repository_failed"
  | "retention_repository_failed"
  | "projection_tick_failed"
  | "historical_interpretation_failed"
  | "enrichment_schedule_failed"
  | "enrichment_batch_failed"
  | "enrichment_claim_failed"
  | "enrichment_context_unavailable"
  | "enrichment_provider_error"
  | "enrichment_invalid_output"
  | "enrichment_repository_failed"
  | "operational_snapshot_failed"
  | "corpus_invalidation_failed";

export type ContentPlanWorkerProjectionState =
  | "bootstrapping"
  | "ready"
  | "updating"
  | "delayed"
  | "reprojecting"
  | "degraded"
  | "budget_paused";

export type ContentPlanProviderOperation =
  | "embedding"
  | "historical_interpretation"
  | "topic_label"
  | "content_brief";

export interface ContentPlanWorkerEvent {
  stage: ContentPlanWorkerStage;
  outcome: ContentPlanWorkerOutcome;
  reason?: ContentPlanWorkerFailureReason;
  workspaceId?: string;
  generationId?: string;
  observationId?: string;
  topicId?: string;
  attemptCount?: number;
  itemCount?: number;
  durationMs?: number;
  vectorSource?: "reused" | "fallback";
  assignmentOutcome?: "created" | "existing";
  lifecycle?: "provisional" | "mature" | "retired";
  revision?: number;
  projectionKind?: "bootstrap" | "reprojection";
  projectionState?: ContentPlanWorkerProjectionState;
  processedCount?: number;
  totalCount?: number;
  projectionLagSeconds?: number;
  pendingObservationCount?: number;
  pendingEmbeddingCount?: number;
  pendingAssignmentCount?: number;
  pendingEnrichmentCount?: number;
  provisionalTopicCount?: number;
  matureTopicCount?: number;
  mergedTopicCount?: number;
  providerOperation?: ContentPlanProviderOperation;
  providerCallCount?: number;
}

export interface ContentPlanWorkerEventSink {
  record(event: ContentPlanWorkerEvent): void;
}

interface ContentPlanLoggerPort {
  info(fields: ContentPlanWorkerEvent, message: string): void;
  warn(fields: ContentPlanWorkerEvent, message: string): void;
}

interface ContentPlanMetricsPort {
  incrementCounter(name: string, options: {
    help: string;
    labels: Record<string, string>;
    value?: number;
  }): void;
  observeHistogram(name: string, options: {
    help: string;
    labels: Record<string, string>;
    value: number;
  }): void;
  setGauge?(name: string, options: {
    help: string;
    labels: Record<string, string>;
    value: number;
  }): void;
}

interface ContentPlanTracePort {
  record(name: string, attributes: Record<string, string | number>): void;
}

export interface ContentPlanningWorkerObservabilityOptions {
  clock?: () => number;
  projectionSnapshotTtlMs?: number;
  maxProjectionSnapshots?: number;
}

const DEFAULT_PROJECTION_SNAPSHOT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_PROJECTION_SNAPSHOTS = 10_000;

export class ContentPlanningWorkerObservability implements ContentPlanWorkerEventSink {
  private readonly projectionSnapshots = new Map<string, ContentPlanMetricSnapshot>();
  private readonly clock: () => number;
  private readonly projectionSnapshotTtlMs: number;
  private readonly maxProjectionSnapshots: number;

  constructor(private readonly sinks: {
    logger?: ContentPlanLoggerPort;
    metrics?: ContentPlanMetricsPort;
    tracer?: ContentPlanTracePort;
  } = {}, options: ContentPlanningWorkerObservabilityOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.projectionSnapshotTtlMs = options.projectionSnapshotTtlMs
      ?? DEFAULT_PROJECTION_SNAPSHOT_TTL_MS;
    this.maxProjectionSnapshots = options.maxProjectionSnapshots
      ?? DEFAULT_MAX_PROJECTION_SNAPSHOTS;
    if (
      !Number.isSafeInteger(this.projectionSnapshotTtlMs)
      || this.projectionSnapshotTtlMs < 1
      || !Number.isSafeInteger(this.maxProjectionSnapshots)
      || this.maxProjectionSnapshots < 1
    ) {
      throw new Error("Content planning observability options are invalid");
    }
  }

  record(event: ContentPlanWorkerEvent): void {
    const safeEvent = toSafeEvent(event);
    if (!safeEvent) return;
    const warning = safeEvent.outcome === "retry_scheduled"
      || safeEvent.outcome === "terminal_failure"
      || safeEvent.outcome === "budget_paused";
    try {
      if (warning) {
        this.sinks.logger?.warn(safeEvent, "content_planning_worker_event");
      } else {
        this.sinks.logger?.info(safeEvent, "content_planning_worker_event");
      }
    } catch {
      // Observability must never change projection outcomes.
    }

    const labels = {
      stage: safeEvent.stage,
      outcome: safeEvent.outcome,
      reason: safeEvent.reason ?? "none",
      vector_source: safeEvent.vectorSource ?? "none",
      assignment_outcome: safeEvent.assignmentOutcome ?? "none",
      lifecycle: safeEvent.lifecycle ?? "none",
    };
    try {
      this.sinks.metrics?.incrementCounter("content_planning_worker_events_total", {
        help: "Content planning worker events by bounded stage and outcome.",
        labels,
        value: safeEvent.itemCount ?? 1,
      });
      if (safeEvent.durationMs !== undefined) {
        this.sinks.metrics?.observeHistogram("content_planning_worker_stage_duration_ms", {
          help: "Content planning worker stage duration in milliseconds.",
          labels,
          value: safeEvent.durationMs,
        });
      }
      this.recordProjectionMetrics(safeEvent);
      this.recordEnrichmentMetrics(safeEvent);
      this.recordProviderMetrics(safeEvent);
      this.recordAssignmentMetrics(safeEvent);
    } catch {
      // Observability must never change projection outcomes.
    }

    try {
      this.sinks.tracer?.record(`content_planning.worker.${safeEvent.stage}`, toTraceAttributes(safeEvent));
    } catch {
      // Observability must never change projection outcomes.
    }
  }

  private recordProjectionMetrics(event: ContentPlanWorkerEvent): void {
    if (
      event.stage !== "projection_snapshot"
      || !event.workspaceId
      || !event.generationId
      || !event.projectionKind
      || !event.projectionState
      || event.pendingObservationCount === undefined
      || event.pendingEmbeddingCount === undefined
      || event.pendingAssignmentCount === undefined
      || event.pendingEnrichmentCount === undefined
      || event.provisionalTopicCount === undefined
      || event.matureTopicCount === undefined
      || event.mergedTopicCount === undefined
    ) return;
    const capturedAtMs = this.clock();
    this.evictProjectionSnapshots(capturedAtMs);
    if (
      !this.projectionSnapshots.has(event.workspaceId)
      && this.projectionSnapshots.size >= this.maxProjectionSnapshots
    ) {
      const oldest = [...this.projectionSnapshots.entries()]
        .sort((left, right) => left[1].capturedAtMs - right[1].capturedAtMs)[0];
      if (oldest) this.projectionSnapshots.delete(oldest[0]);
    }
    this.projectionSnapshots.set(event.workspaceId, {
      generationId: event.generationId,
      capturedAtMs,
      projectionKind: event.projectionKind,
      projectionState: event.projectionState,
      processedCount: event.processedCount,
      totalCount: event.totalCount,
      projectionLagSeconds: event.projectionLagSeconds,
      pendingObservationCount: event.pendingObservationCount,
      pendingEmbeddingCount: event.pendingEmbeddingCount,
      pendingAssignmentCount: event.pendingAssignmentCount,
      pendingEnrichmentCount: event.pendingEnrichmentCount,
      provisionalTopicCount: event.provisionalTopicCount,
      matureTopicCount: event.matureTopicCount,
      mergedTopicCount: event.mergedTopicCount,
    });
    this.writeProjectionGauges();
  }

  private recordEnrichmentMetrics(event: ContentPlanWorkerEvent): void {
    if (event.stage !== "enrichment" || event.providerOperation) return;
    this.sinks.metrics?.incrementCounter("content_planning_enrichment_outcomes_total", {
      help: "Content planning enrichment outcomes by bounded result and reason.",
      labels: { outcome: event.outcome, reason: event.reason ?? "none" },
      value: event.itemCount ?? 1,
    });
    if (event.durationMs !== undefined) {
      this.sinks.metrics?.observeHistogram("content_planning_enrichment_latency_ms", {
        help: "Content planning enrichment latency in milliseconds.",
        labels: { outcome: event.outcome },
        value: event.durationMs,
      });
    }
  }

  private recordProviderMetrics(event: ContentPlanWorkerEvent): void {
    if (!event.providerOperation || event.providerCallCount === undefined) return;
    this.sinks.metrics?.incrementCounter("content_planning_provider_calls_total", {
      help: "Content planning provider calls by bounded operation and outcome.",
      labels: { operation: event.providerOperation, outcome: event.outcome },
      value: event.providerCallCount,
    });
  }

  private recordAssignmentMetrics(event: ContentPlanWorkerEvent): void {
    if (event.stage !== "assignment" || !event.assignmentOutcome || !event.vectorSource) return;
    const value = event.itemCount ?? 1;
    this.sinks.metrics?.incrementCounter("content_planning_embedding_vectors_total", {
      help: "Content planning assigned vectors by reused or fallback source.",
      labels: { vector_source: event.vectorSource },
      value,
    });
    this.sinks.metrics?.incrementCounter("content_planning_assignment_outcomes_total", {
      help: "Content planning assignment outcomes by bounded result and lifecycle.",
      labels: {
        assignment_outcome: event.assignmentOutcome,
        lifecycle: event.lifecycle ?? "none",
      },
      value,
    });
  }

  private evictProjectionSnapshots(nowMs: number): void {
    for (const [workspaceId, snapshot] of this.projectionSnapshots) {
      if (
        nowMs < snapshot.capturedAtMs
        || nowMs - snapshot.capturedAtMs > this.projectionSnapshotTtlMs
      ) {
        this.projectionSnapshots.delete(workspaceId);
      }
    }
  }

  private writeProjectionGauges(): void {
    const metrics = this.sinks.metrics;
    if (!metrics?.setGauge) return;
    const snapshots = [...this.projectionSnapshots.values()];
    for (const projectionState of projectionStates) {
      const matching = snapshots.filter((snapshot) => snapshot.projectionState === projectionState);
      metrics.setGauge("content_planning_projection_lag_seconds", {
        help: "Maximum content planning coherent projection lag in seconds.",
        labels: { projection_state: projectionState },
        value: Math.max(0, ...matching.map((snapshot) => snapshot.projectionLagSeconds ?? 0)),
      });
      metrics.setGauge("content_planning_pending_observations", {
        help: "Current content planning pending observation backlog.",
        labels: { projection_state: projectionState },
        value: sum(matching, (snapshot) => snapshot.pendingObservationCount),
      });
      for (const [backlog, valueFor] of [
        ["embedding", (snapshot: ContentPlanMetricSnapshot) => snapshot.pendingEmbeddingCount],
        ["assignment", (snapshot: ContentPlanMetricSnapshot) => snapshot.pendingAssignmentCount],
        ["enrichment", (snapshot: ContentPlanMetricSnapshot) => snapshot.pendingEnrichmentCount],
      ] as const) {
        metrics.setGauge("content_planning_projection_backlog", {
          help: "Current content planning backlog by bounded work kind.",
          labels: { backlog, projection_state: projectionState },
          value: sum(matching, valueFor),
        });
      }
      for (const projectionKind of projectionKinds) {
        const progressing = matching.filter((snapshot) =>
          snapshot.projectionKind === projectionKind
          && snapshot.processedCount !== undefined
          && snapshot.totalCount !== undefined
          && snapshot.totalCount > 0);
        const processed = sum(progressing, (snapshot) => snapshot.processedCount ?? 0);
        const total = sum(progressing, (snapshot) => snapshot.totalCount ?? 0);
        metrics.setGauge("content_planning_projection_progress_ratio", {
          help: "Current content planning bootstrap and reprojection completion ratio.",
          labels: { projection_kind: projectionKind, projection_state: projectionState },
          value: total === 0 ? 0 : Math.min(1, processed / total),
        });
      }
    }
    for (const [lifecycle, valueFor] of [
      ["provisional", (snapshot: ContentPlanMetricSnapshot) => snapshot.provisionalTopicCount],
      ["mature", (snapshot: ContentPlanMetricSnapshot) => snapshot.matureTopicCount],
      ["merged", (snapshot: ContentPlanMetricSnapshot) => snapshot.mergedTopicCount],
    ] as const) {
      metrics.setGauge("content_planning_topic_count", {
        help: "Current content planning topic count by bounded lifecycle.",
        labels: { lifecycle },
        value: sum(snapshots, valueFor),
      });
    }
    metrics.setGauge("content_planning_topic_merge_count", {
      help: "Current content planning merged topic count.",
      labels: {},
      value: sum(snapshots, (snapshot) => snapshot.mergedTopicCount),
    });
  }
}

interface ContentPlanMetricSnapshot {
  generationId: string;
  capturedAtMs: number;
  projectionKind: "bootstrap" | "reprojection";
  projectionState: ContentPlanWorkerProjectionState;
  processedCount?: number;
  totalCount?: number;
  projectionLagSeconds?: number;
  pendingObservationCount: number;
  pendingEmbeddingCount: number;
  pendingAssignmentCount: number;
  pendingEnrichmentCount: number;
  provisionalTopicCount: number;
  matureTopicCount: number;
  mergedTopicCount: number;
}

const sum = <Value>(values: readonly Value[], valueFor: (value: Value) => number): number =>
  values.reduce((total, value) => total + valueFor(value), 0);

const workerStages = [
  "claim",
  "source",
  "embedding",
  "assignment",
  "reconciliation",
  "retention",
  "discovery",
  "bootstrap",
  "reprojection",
  "projection_snapshot",
  "corpus_invalidation",
  "enrichment_schedule",
  "enrichment",
] as const satisfies readonly ContentPlanWorkerStage[];

const workerOutcomes = [
  "claimed",
  "completed",
  "retry_scheduled",
  "terminal_failure",
  "stale",
  "skipped",
  "created_topic",
  "assigned_existing",
  "matured",
  "retired",
  "budget_paused",
  "progressed",
  "awaiting_projection",
  "promoted",
  "up_to_date",
  "busy",
  "published",
] as const satisfies readonly ContentPlanWorkerOutcome[];

const workerFailureReasons = [
  "lease_expired",
  "missing_claim_token",
  "invalid_claim_state",
  "claim_repository_failed",
  "source_load_failed",
  "source_unavailable",
  "semantic_intent_missing",
  "semantic_hash_mismatch",
  "semantic_intent_ambiguous",
  "embedding_budget_reservation_failed",
  "embedding_budget_paused",
  "embedding_provider_failed",
  "embedding_result_count_mismatch",
  "embedding_space_mismatch",
  "embedding_vector_invalid",
  "claim_settlement_failed",
  "assignment_evidence_unavailable",
  "assignment_conflict",
  "assignment_repository_failed",
  "reconciliation_evidence_unavailable",
  "reconciliation_conflict",
  "reconciliation_repository_failed",
  "retention_repository_failed",
  "projection_tick_failed",
  "historical_interpretation_failed",
  "enrichment_schedule_failed",
  "enrichment_batch_failed",
  "enrichment_claim_failed",
  "enrichment_context_unavailable",
  "enrichment_provider_error",
  "enrichment_invalid_output",
  "enrichment_repository_failed",
  "operational_snapshot_failed",
  "corpus_invalidation_failed",
] as const satisfies readonly ContentPlanWorkerFailureReason[];

const vectorSources = ["reused", "fallback"] as const;
const assignmentOutcomes = ["created", "existing"] as const;
const topicLifecycles = ["provisional", "mature", "retired"] as const;
const projectionKinds = ["bootstrap", "reprojection"] as const;
const projectionStates = [
  "bootstrapping",
  "ready",
  "updating",
  "delayed",
  "reprojecting",
  "degraded",
  "budget_paused",
] as const satisfies readonly ContentPlanWorkerProjectionState[];
const providerOperations = [
  "embedding",
  "historical_interpretation",
  "topic_label",
  "content_brief",
] as const satisfies readonly ContentPlanProviderOperation[];

const isOneOf = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): value is Value => typeof value === "string" && allowed.includes(value as Value);

const safeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;

const safeNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const safePositiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const toSafeEvent = (event: ContentPlanWorkerEvent): ContentPlanWorkerEvent | null => {
  if (!isOneOf(event.stage, workerStages) || !isOneOf(event.outcome, workerOutcomes)) return null;
  const reason = isOneOf(event.reason, workerFailureReasons) ? event.reason : undefined;
  const workspaceId = safeIdentifier(event.workspaceId);
  const generationId = safeIdentifier(event.generationId);
  const observationId = safeIdentifier(event.observationId);
  const topicId = safeIdentifier(event.topicId);
  const attemptCount = safeNonNegativeNumber(event.attemptCount);
  const itemCount = safeNonNegativeNumber(event.itemCount);
  const durationMs = safeNonNegativeNumber(event.durationMs);
  const vectorSource = isOneOf(event.vectorSource, vectorSources) ? event.vectorSource : undefined;
  const assignmentOutcome = isOneOf(event.assignmentOutcome, assignmentOutcomes)
    ? event.assignmentOutcome
    : undefined;
  const lifecycle = isOneOf(event.lifecycle, topicLifecycles) ? event.lifecycle : undefined;
  const revision = safePositiveInteger(event.revision);
  const projectionKind = isOneOf(event.projectionKind, projectionKinds)
    ? event.projectionKind
    : undefined;
  const projectionState = isOneOf(event.projectionState, projectionStates)
    ? event.projectionState
    : undefined;
  const processedCount = safeNonNegativeNumber(event.processedCount);
  const totalCount = safeNonNegativeNumber(event.totalCount);
  const projectionLagSeconds = safeNonNegativeNumber(event.projectionLagSeconds);
  const pendingObservationCount = safeNonNegativeNumber(event.pendingObservationCount);
  const pendingEmbeddingCount = safeNonNegativeNumber(event.pendingEmbeddingCount);
  const pendingAssignmentCount = safeNonNegativeNumber(event.pendingAssignmentCount);
  const pendingEnrichmentCount = safeNonNegativeNumber(event.pendingEnrichmentCount);
  const provisionalTopicCount = safeNonNegativeNumber(event.provisionalTopicCount);
  const matureTopicCount = safeNonNegativeNumber(event.matureTopicCount);
  const mergedTopicCount = safeNonNegativeNumber(event.mergedTopicCount);
  const providerOperation = isOneOf(event.providerOperation, providerOperations)
    ? event.providerOperation
    : undefined;
  const providerCallCount = safeNonNegativeNumber(event.providerCallCount);
  return {
    stage: event.stage,
    outcome: event.outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(generationId === undefined ? {} : { generationId }),
    ...(observationId === undefined ? {} : { observationId }),
    ...(topicId === undefined ? {} : { topicId }),
    ...(attemptCount === undefined ? {} : { attemptCount }),
    ...(itemCount === undefined ? {} : { itemCount }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(vectorSource === undefined ? {} : { vectorSource }),
    ...(assignmentOutcome === undefined ? {} : { assignmentOutcome }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(revision === undefined ? {} : { revision }),
    ...(projectionKind === undefined ? {} : { projectionKind }),
    ...(projectionState === undefined ? {} : { projectionState }),
    ...(processedCount === undefined ? {} : { processedCount }),
    ...(totalCount === undefined ? {} : { totalCount }),
    ...(projectionLagSeconds === undefined ? {} : { projectionLagSeconds }),
    ...(pendingObservationCount === undefined ? {} : { pendingObservationCount }),
    ...(pendingEmbeddingCount === undefined ? {} : { pendingEmbeddingCount }),
    ...(pendingAssignmentCount === undefined ? {} : { pendingAssignmentCount }),
    ...(pendingEnrichmentCount === undefined ? {} : { pendingEnrichmentCount }),
    ...(provisionalTopicCount === undefined ? {} : { provisionalTopicCount }),
    ...(matureTopicCount === undefined ? {} : { matureTopicCount }),
    ...(mergedTopicCount === undefined ? {} : { mergedTopicCount }),
    ...(providerOperation === undefined ? {} : { providerOperation }),
    ...(providerCallCount === undefined ? {} : { providerCallCount }),
  };
};

const toTraceAttributes = (
  event: ContentPlanWorkerEvent,
): Record<string, string | number> => Object.fromEntries(
  Object.entries({
    "content_plan.stage": event.stage,
    "content_plan.outcome": event.outcome,
    "content_plan.reason": event.reason,
    "content_plan.workspace_id": event.workspaceId,
    "content_plan.generation_id": event.generationId,
    "content_plan.observation_id": event.observationId,
    "content_plan.topic_id": event.topicId,
    "content_plan.attempt_count": event.attemptCount,
    "content_plan.item_count": event.itemCount,
    "content_plan.duration_ms": event.durationMs,
    "content_plan.vector_source": event.vectorSource,
    "content_plan.assignment_outcome": event.assignmentOutcome,
    "content_plan.lifecycle": event.lifecycle,
    "content_plan.revision": event.revision,
    "content_plan.projection_kind": event.projectionKind,
    "content_plan.projection_state": event.projectionState,
    "content_plan.processed_count": event.processedCount,
    "content_plan.total_count": event.totalCount,
    "content_plan.projection_lag_seconds": event.projectionLagSeconds,
    "content_plan.pending_observation_count": event.pendingObservationCount,
    "content_plan.pending_embedding_count": event.pendingEmbeddingCount,
    "content_plan.pending_assignment_count": event.pendingAssignmentCount,
    "content_plan.pending_enrichment_count": event.pendingEnrichmentCount,
    "content_plan.provisional_topic_count": event.provisionalTopicCount,
    "content_plan.mature_topic_count": event.matureTopicCount,
    "content_plan.merged_topic_count": event.mergedTopicCount,
    "content_plan.provider_operation": event.providerOperation,
    "content_plan.provider_call_count": event.providerCallCount,
  }).filter((entry): entry is [string, string | number] =>
    typeof entry[1] === "string" || typeof entry[1] === "number"),
);

export const NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY: ContentPlanWorkerEventSink = {
  record: () => undefined,
};
