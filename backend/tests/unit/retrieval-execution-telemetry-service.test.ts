import { describe, expect, it } from "vitest";

import { selectRetrievalAnswerShape } from "../../src/modules/retrieval/services/retrievalShapeResolver.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { buildTelemetrySinks } from "../../src/shared/observability/telemetry/buildTelemetrySinks.js";
import { TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";

describe("retrieval execution telemetry service", () => {
  it("returns diagnostics and emits retrieval metrics", async () => {
    const { metricsRegistry, sinks } = buildTelemetrySinks({ METRICS_ENABLED: true });
    const telemetryService = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: createLogger("silent"),
      service: "radioso-api",
      sinks,
      version: "test",
    });
    const service = new RetrievalExecutionTelemetryService(telemetryService);

    const diagnostics = await service.create({
      workspaceId: "workspace-1",
      rewriteStatus: "applied",
      rerankStatus: "applied",
      originalCandidateCount: 4,
      rewrittenCandidateCount: 3,
      lexicalCandidateCount: 1,
      normalizedCandidateCount: 3,
      finalContextCount: 2,
      queryEmbeddingDurationMs: 18,
      candidateFallbackApplied: false,
      rewriteEligible: true,
      rewriteRan: true,
      appliedConstraints: [],
      retrievalSubqueries: [],
    });

    expect(diagnostics.fallbackApplied).toBe(false);
    const metrics = metricsRegistry?.renderPrometheus() ?? "";
    expect(metrics).toContain("radioso_retrieval_pipeline_runs_total");
    expect(metrics).toContain('fallback_applied="false"');
    expect(metrics).toContain('rerank_status="applied"');
    expect(metrics).toContain('rewrite_status="applied"');
    expect(metrics).toContain("radioso_retrieval_candidate_count_bucket");
  });

  it("marks fallback runs in the emitted telemetry tags", async () => {
    const { metricsRegistry, sinks } = buildTelemetrySinks({ METRICS_ENABLED: true });
    const telemetryService = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: createLogger("silent"),
      service: "radioso-api",
      sinks,
      version: "test",
    });
    const service = new RetrievalExecutionTelemetryService(telemetryService);

    const diagnostics = await service.create({
      workspaceId: "workspace-1",
      rewriteStatus: "fallback",
      rerankStatus: "fallback",
      originalCandidateCount: 0,
      rewrittenCandidateCount: 0,
      lexicalCandidateCount: 0,
      normalizedCandidateCount: 0,
      finalContextCount: 0,
      candidateFallbackApplied: false,
    });

    expect(diagnostics.fallbackApplied).toBe(true);
    const metrics = metricsRegistry?.renderPrometheus() ?? "";
    expect(metrics).toContain("radioso_retrieval_pipeline_runs_total");
    expect(metrics).toContain('fallback_applied="true"');
    expect(metrics).toContain('rerank_status="fallback"');
    expect(metrics).toContain('rewrite_status="fallback"');
  });

  it("carries assistant and retrieval route diagnostics into telemetry metadata", async () => {
    const { metricsRegistry, sinks } = buildTelemetrySinks({ METRICS_ENABLED: true });
    const telemetryService = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: createLogger("silent"),
      service: "radioso-api",
      sinks,
      version: "test",
    });
    const service = new RetrievalExecutionTelemetryService(telemetryService);

    const diagnostics = await service.create({
      workspaceId: "workspace-1",
      execution: {
        surface: "retrieval",
        path: "retrieval_answer",
        retrievalInvoked: true,
      },
      rewriteStatus: "applied",
      rerankStatus: "skipped",
      originalCandidateCount: 2,
      rewrittenCandidateCount: 0,
      lexicalCandidateCount: 1,
      normalizedCandidateCount: 2,
      finalContextCount: 1,
      candidateFallbackApplied: false,
    });

    expect(diagnostics.execution).toEqual({
      surface: "retrieval",
      path: "retrieval_answer",
      retrievalInvoked: true,
    });
    const metrics = metricsRegistry?.renderPrometheus() ?? "";
    expect(metrics).toContain('execution_surface="retrieval"');
    expect(metrics).toContain('execution_path="retrieval_answer"');
  });

  it("emits retrieval shape tags without raw query or document content", async () => {
    const emitted: unknown[] = [];
    const telemetryService = {
      async emit(event: unknown) {
        emitted.push(event);
        return event;
      },
    };
    const service = new RetrievalExecutionTelemetryService(telemetryService as never);

    const shapeSelection = selectRetrievalAnswerShape({
      query: "What is BM25?",
      rewrittenQuery: {
        originalQuery: "What is BM25?",
        rewrittenQuery: "BM25",
        effectiveQuery: "BM25",
        semanticQuery: "BM25",
        lexicalQuery: "BM25",
        responseIntent: "retrieval",
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied",
        confidence: 0.9,
        structuredResult: {
          rewrittenQuery: "BM25",
          queryShape: "definition_lookup",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
    });

    await service.create({
      workspaceId: "workspace-1",
      execution: {
        surface: "retrieval",
        path: "retrieval_answer",
        retrievalInvoked: true,
      },
      rewriteStatus: "applied",
      rerankStatus: "skipped",
      originalCandidateCount: 1,
      rewrittenCandidateCount: 0,
      lexicalCandidateCount: 2,
      normalizedCandidateCount: 2,
      finalContextCount: 1,
      candidateFallbackApplied: false,
      shapeSelection,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      eventType: "retrieval.pipeline.completed",
      metadata: {
        skillName: "retrieval.answer",
        shapeName: "definition_lookup",
        queryShape: "definition_lookup",
        selectionMode: "probabilistic",
        selectionReason: shapeSelection.selectionReason,
      },
      tags: {
        skill_name: "retrieval.answer",
        shape_name: "definition_lookup",
        query_shape: "definition_lookup",
        selection_mode: "probabilistic",
      },
    });
    expect(JSON.stringify(emitted[0])).not.toContain("What is BM25");
    expect(JSON.stringify(emitted[0])).not.toContain("sourceContent");
  });
});
