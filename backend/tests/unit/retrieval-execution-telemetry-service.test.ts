import { describe, expect, it } from "vitest";

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
    expect(metricsRegistry?.renderPrometheus()).toContain(
      'radioso_retrieval_pipeline_runs_total{fallback_applied="false",rerank_status="applied",rewrite_status="applied"} 1',
    );
    expect(metricsRegistry?.renderPrometheus()).toContain("radioso_retrieval_candidate_count_bucket");
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
    expect(metricsRegistry?.renderPrometheus()).toContain(
      'radioso_retrieval_pipeline_runs_total{fallback_applied="true",rerank_status="fallback",rewrite_status="fallback"} 1',
    );
  });
});
